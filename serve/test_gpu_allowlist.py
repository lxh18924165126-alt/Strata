"""NVIDIA allowlist enforcement for all model child environments."""
import argparse
import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from strata_control import gpu_allowlist
from serve.images import ImageGen, ImageJobFailed, image_env
from serve import lifeline, server
from serve.server import child_env, vision_env
from strata_control import runtime
from strata_cli.launch import cmd
from strata_cli.launch.catalog import Catalog
from tools import strata_mcp


UUID0 = "GPU-00000000-0000-0000-0000-000000000000"
UUID1 = "GPU-11111111-1111-1111-1111-111111111111"
UUID2 = "GPU-22222222-2222-2222-2222-222222222222"
UUID3 = "GPU-33333333-3333-3333-3333-333333333333"
HOST = {0: UUID0, 1: UUID1, 2: UUID2, 3: UUID3}


class Allowlist(unittest.TestCase):
    def setUp(self):
        self.environment = mock.patch.dict(os.environ, {"STRATA_GPU_ALLOWLIST": f"{UUID2},{UUID3}"}, clear=True)
        self.discovery = mock.patch.object(gpu_allowlist, "nvidia_gpu_uuids", return_value=HOST)
        self.environment.start()
        self.discovery.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.discovery.stop)

    def test_missing_policy_does_not_change_existing_behavior(self):
        del os.environ["STRATA_GPU_ALLOWLIST"]
        self.assertIsNone(gpu_allowlist.load())
        gpu_allowlist.nvidia_gpu_uuids.assert_not_called()

    def test_default_and_explicit_host_indices_resolve_to_uuids(self):
        policy = gpu_allowlist.load()
        self.assertEqual(policy.restrict_env({})["CUDA_VISIBLE_DEVICES"], f"{UUID2},{UUID3}")
        self.assertEqual(policy.restrict_env({}, selected=[3, 2])["CUDA_VISIBLE_DEVICES"], f"{UUID3},{UUID2}")
        with self.assertRaises(ValueError):
            policy.restrict_env({}, selected=[0])
        with self.assertRaises(ValueError):
            policy.restrict_env({}, selected=[99])

    def test_unknown_configured_uuid_is_rejected(self):
        for value in ("GPU-unknown", UUID2 + "," + UUID2, ""):
            os.environ["STRATA_GPU_ALLOWLIST"] = value
            with self.assertRaisesRegex(ValueError, "full NVIDIA GPU UUIDs"):
                gpu_allowlist.load()
        os.environ["STRATA_GPU_ALLOWLIST"] = UUID2
        with mock.patch.object(gpu_allowlist, "nvidia_gpu_uuids", return_value={0: UUID3}):
            with self.assertRaisesRegex(ValueError, "not visible to nvidia-smi"):
                gpu_allowlist.load()

    def test_existing_mask_cannot_bypass_policy_and_empty_mask_stays_empty(self):
        policy = gpu_allowlist.load()
        self.assertEqual(policy.restrict_env({"CUDA_VISIBLE_DEVICES": ""})["CUDA_VISIBLE_DEVICES"], "")
        self.assertEqual(policy.restrict_env({"CUDA_VISIBLE_DEVICES": UUID2})["CUDA_VISIBLE_DEVICES"], UUID2)
        with self.assertRaises(ValueError):
            policy.restrict_env({"CUDA_VISIBLE_DEVICES": UUID0})
        with self.assertRaises(ValueError):
            policy.restrict_env({"CUDA_VISIBLE_DEVICES": "GPU-unknown"})

    def test_host_and_container_ordinal_mapping_uses_uuid_identity(self):
        host = gpu_allowlist.load()
        self.assertEqual(host.restrict_env({}, selected=[2])["CUDA_VISIBLE_DEVICES"], UUID2)
        with mock.patch.object(gpu_allowlist, "nvidia_gpu_uuids", return_value={0: UUID2, 1: UUID3}):
            container = gpu_allowlist.load()
            self.assertEqual(container.restrict_env({}, selected=[0, 1])["CUDA_VISIBLE_DEVICES"], f"{UUID2},{UUID3}")
            with self.assertRaises(ValueError):
                container.restrict_env({}, selected=[2])

    def test_children_honor_allowlist_and_reject_outside_cards(self):
        cfg = {"backend": "cuda", "gpu": 2, "args": []}
        engine_env = child_env(cfg)
        self.assertEqual(engine_env["CUDA_VISIBLE_DEVICES"], UUID2)
        self.assertEqual(vision_env({"backend": "cuda", "vision": {"cuda_device": 3}}, engine_env)
                         ["CUDA_VISIBLE_DEVICES"], UUID3)
        self.assertEqual(image_env({"backend": "cuda", "gpu": 3}, {})["CUDA_VISIBLE_DEVICES"], UUID3)
        with self.assertRaises(ValueError):
            child_env({**cfg, "gpu": 0})
        with self.assertRaises(ValueError):
            vision_env({"backend": "cuda", "vision": {"cuda_device": 0}}, engine_env)
        with self.assertRaises(ValueError):
            image_env({"backend": "cuda", "gpu": 0}, {})
        with self.assertRaisesRegex(ValueError, "image generation backend"):
            image_env({}, {})
        with self.assertRaisesRegex(ValueError, "image generation backend 'vulkan'"):
            image_env({"backend": "vulkan"}, {})

    def test_default_children_and_empty_mask(self):
        engine_env = child_env({"backend": "cuda", "args": []})
        self.assertEqual(engine_env["CUDA_VISIBLE_DEVICES"], f"{UUID2},{UUID3}")
        self.assertEqual(vision_env({"backend": "cuda"}, engine_env)["CUDA_VISIBLE_DEVICES"], f"{UUID2},{UUID3}")
        self.assertEqual(image_env({"backend": "cuda"}, {})["CUDA_VISIBLE_DEVICES"], f"{UUID2},{UUID3}")
        self.assertEqual(child_env({"backend": "cpu", "gpu_none": True, "gpu": [], "args": []})
                         ["CUDA_VISIBLE_DEVICES"], "")

    def test_config_env_cannot_override_device_selection(self):
        for build in (
            lambda mask: child_env({"backend": "cuda", "gpu": 2, "args": [],
                                    "env": {"CUDA_VISIBLE_DEVICES": mask}}),
            lambda mask: image_env({"backend": "cuda", "gpu": 2,
                                    "env": {"CUDA_VISIBLE_DEVICES": mask}}, {}),
        ):
            with self.subTest(build=build):
                self.assertEqual(build("2")["CUDA_VISIBLE_DEVICES"], UUID2)
                for conflicting_mask in ("0", "3"):
                    with self.assertRaises(ValueError):
                        build(conflicting_mask)

    def test_profile_cannot_set_the_owner_allowlist(self):
        cfg = {"backend": "cuda", "env": {"STRATA_GPU_ALLOWLIST": UUID0}}
        with self.assertRaisesRegex(ValueError, "before starting Strata"):
            child_env(cfg)
        del os.environ["STRATA_GPU_ALLOWLIST"]
        with self.assertRaisesRegex(ValueError, "before starting Strata"):
            child_env(cfg)

    def test_reusing_child_environment_does_not_reinterpret_uuids(self):
        policy = gpu_allowlist.load()
        first = policy.restrict_env({}, selected=[2, 3])
        second = policy.restrict_env(dict(first))
        self.assertEqual(second["CUDA_VISIBLE_DEVICES"], first["CUDA_VISIBLE_DEVICES"])

    def test_engine_spawn_and_restart_keep_uuid_mask_and_remove_legacy_override(self):
        env = child_env({"backend": "cuda", "gpu": 2})
        with mock.patch.object(server, "end_leftover_engines"), \
             mock.patch.object(server, "popen", side_effect=OSError("stop at spawn")) as spawn:
            with self.assertRaisesRegex(OSError, "stop at spawn"):
                server.StrataEngine("strata", ["--gpu", "2", "--max-context", "4096"], env=env)
            engine = server.StrataEngine("strata", ["--gpu", UUID2], env=env, lazy=True)
            with self.assertRaisesRegex(OSError, "stop at spawn"):
                engine.restart()
        self.assertEqual(spawn.call_count, 2)
        for call in spawn.call_args_list:
            self.assertNotIn("--gpu", call.args[1])
            self.assertEqual(call.kwargs["env"]["CUDA_VISIBLE_DEVICES"], UUID2)

    def test_conflicting_engine_args_and_retries_fail_before_spawn(self):
        env = child_env({"backend": "cuda", "gpu": 2})
        with mock.patch.object(server, "popen") as spawn:
            for kwargs in ({"args": ["--gpu", "0"]}, {"args": ["--gpu=3"]}, {"args": [], "retry_args": ["--gpu", "0"]}):
                with self.assertRaisesRegex(ValueError, "STRATA_GPU_ALLOWLIST"):
                    server.StrataEngine("strata", env=env, **kwargs)
            spawn.assert_not_called()

    def test_deepseek_gpus_argument_uses_cuda_local_ordinals(self):
        env = child_env({"backend": "cuda", "gpu": [2, 3], "gpu_order": "as_given"})
        args = ["--gpus", "0,1"]
        engine = server.StrataEngine("strata-dsv41", args, env=env, lazy=True)
        self.assertEqual(engine.spawn[1], args)
        self.assertEqual(engine.spawn[4]["CUDA_VISIBLE_DEVICES"], f"{UUID2},{UUID3}")
        with self.assertRaisesRegex(ValueError, "outside its 2 CUDA-visible devices"):
            server.StrataEngine("strata-dsv41", ["--gpus", "2,3"], env=env, lazy=True)

    def test_picture_reader_restart_keeps_its_own_device(self):
        env = vision_env({"vision": {"cuda_device": 3}}, child_env({"gpu": 2}))
        cfg = {"exe": "strata-vision", "mmproj": "projector", "model": "model", "gpu": True}
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(server.Vision, "work_dir", return_value=Path(tmp)), \
             mock.patch.object(server.Vision, "_await_ready", return_value="READY"), \
             mock.patch.object(server, "popen") as spawn:
            vision = server.Vision(cfg, env=env)
            vision.restart()
        self.assertEqual([call.kwargs["env"]["CUDA_VISIBLE_DEVICES"] for call in spawn.call_args_list], [UUID3, UUID3])

    def test_image_generation_passes_the_uuid_mask_to_sd_cli(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(lifeline, "popen", side_effect=OSError("stop at spawn")) as spawn:
            gen = ImageGen({"exe": "sd-cli", "diffusion_model": "diffusion", "vae": "vae", "llm": "llm",
                            "out_dir": tmp, "backend": "cuda", "gpu": 3})
            with self.assertRaisesRegex(ImageJobFailed, "stop at spawn"):
                gen.run({"prompt": "blue cup", "width": 512, "height": 512, "steps": 8, "seed": 42, "n": 1})
        self.assertEqual(spawn.call_args.kwargs["env"]["CUDA_VISIBLE_DEVICES"], UUID3)

    def test_runtime_owner_refuses_restart_with_changed_allowlist(self):
        host = runtime.Host.__new__(runtime.Host)
        host.token = "owner-token"
        with mock.patch.object(host, "_restart", return_value={"ok": True}) as restart:
            request = {"command": "restart", "token": host.token, "gpu_allowlist": UUID0}
            self.assertIn("stop the runtime owner", host._handle(request)["error"])
            restart.assert_not_called()
            self.assertTrue(host._handle({**request, "gpu_allowlist": os.environ["STRATA_GPU_ALLOWLIST"]})["ok"])
            restart.assert_called_once()

    def test_replica_and_split_reject_outside_cards_before_first_engine(self):
        cfg = {"backend": "cuda", "args": []}
        split = {"prefill_gpu": 2, "decode_gpu": 0, "prefill_args": [], "decode_args": []}
        with mock.patch.object(server, "StrataEngine") as spawn:
            with self.assertRaisesRegex(ValueError, "outside the allowed"):
                server.start_replicas(cfg, [[2], [0]], "strata", [], False)
            with self.assertRaisesRegex(ValueError, "outside the allowed"):
                server.start_split(cfg, split, "strata", [], False)
            spawn.assert_not_called()

    def test_launch_plan_rejects_host_gpu_zero(self):
        parser = argparse.ArgumentParser()
        cmd.add_parsers(parser.add_subparsers())
        args = parser.parse_args(["launch", "--plan", "--family", "qwen", "--model", "q2_0", "--gpu", "0"])
        stderr = io.StringIO()
        with mock.patch("strata_cli.launch.catalog.Catalog") as catalog, contextlib.redirect_stderr(stderr):
            catalog.return_value.resolve.return_value = ("qwen", "q2_0")
            self.assertEqual(cmd.run_launch(args), 2)
        self.assertIn("GPU '0' is outside the allowed", stderr.getvalue())

    def test_automatic_launch_choices_only_see_allowed_nvidia_cards(self):
        catalog = Catalog.__new__(Catalog)
        devices = [{"index": index, "vendor": "nvidia"} for index in HOST]
        with mock.patch.object(catalog, "hardware", return_value={"gpus": devices}):
            self.assertEqual([gpu["index"] for gpu in catalog.computer().gpus], [2, 3])

    def test_desktop_hardware_snapshot_keeps_the_real_allowed_indices(self):
        devices = [{"index": index, "arch": "89", "vram_gb": 48} for index in HOST]
        with tempfile.TemporaryDirectory() as tmp:
            control = strata_mcp.Strata(tmp, Path(__file__).resolve().parents[1])
            with mock.patch.object(control, "setup_module", return_value=None), \
                 mock.patch.object(strata_mcp, "own_nvidia_gpus", return_value=devices), \
                 mock.patch.object(strata_mcp, "physical_cores", return_value=8), \
                 mock.patch.object(strata_mcp, "nvidia_display_active", return_value={}), \
                 mock.patch.object(strata_mcp, "windows_video_controllers", return_value=[]), \
                 mock.patch("strata_control.gpu_roles.add_speeds"):
                hardware = control._hardware()
        self.assertEqual(hardware["engine_vendor"], "nvidia")
        self.assertEqual([gpu["index"] for gpu in hardware["gpus"]], [2, 3])


if __name__ == "__main__":
    unittest.main()
