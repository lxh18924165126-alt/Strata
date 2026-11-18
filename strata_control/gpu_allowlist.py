"""An opt-in NVIDIA device limit inherited from the Strata process environment."""

import os
import re
import subprocess
from dataclasses import dataclass
from functools import lru_cache


VAR = "STRATA_GPU_ALLOWLIST"
MASK = "CUDA_VISIBLE_DEVICES"
UUID = re.compile(r"GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)


class AllowlistError(ValueError):
    def __init__(self, message):
        super().__init__(f"{VAR}: {message}")


@lru_cache(maxsize=1)
def nvidia_gpu_uuids() -> dict[int, str]:
    """The current process uses one nvidia-smi numbering snapshot; children use UUIDs."""
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
                                capture_output=True, text=True, check=True, timeout=10,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        devices = {}
        for line in result.stdout.splitlines():
            index, uuid = (part.strip() for part in line.split(","))
            if not index.isascii() or not index.isdecimal() or not UUID.fullmatch(uuid) or int(index) in devices:
                raise ValueError(line)
            devices[int(index)] = uuid
        if len({uuid.lower() for uuid in devices.values()}) != len(devices):
            raise ValueError("duplicate GPU UUIDs")
        return devices
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise AllowlistError(f"cannot identify NVIDIA GPUs with nvidia-smi ({exc})") from exc


@dataclass(frozen=True)
class Allowlist:
    devices: dict[int, str]
    allowed: tuple[str, ...]

    def resolve(self, value) -> list[str]:
        if value == "":
            return []
        tokens = value if isinstance(value, (list, tuple)) else str(value).split(",")
        resolved = []
        for token in tokens:
            name = str(token).strip()
            uuid = self.devices.get(int(name)) if name.isascii() and name.isdecimal() else name
            match = next((item for item in self.allowed if uuid and item.lower() == uuid.lower()), None)
            if match is None:
                raise AllowlistError(f"GPU {name!r} is outside the allowed NVIDIA devices")
            if match in resolved:
                raise AllowlistError(f"GPU {name!r} is listed more than once")
            resolved.append(match)
        return resolved

    def indexes(self, value) -> list[int]:
        by_uuid = {uuid: index for index, uuid in self.devices.items()}
        return [by_uuid[uuid] for uuid in self.resolve(value)]

    def require_backend(self, backend, *, name="engine") -> None:
        if backend not in (None, "cuda", "cpu"):
            raise AllowlistError(f"{name} backend {backend!r} is unsupported with an NVIDIA GPU allowlist")

    def restrict_env(self, env: dict, selected=None) -> dict:
        if os.name == "nt":
            env = {key.upper(): value for key, value in env.items()}
        value = env.get(MASK, self.allowed) if selected is None else selected
        return {**env, VAR: ",".join(self.allowed), MASK: ",".join(self.resolve(value)), "CUDA_DEVICE_ORDER": "PCI_BUS_ID"}


def load(environ=None) -> Allowlist | None:
    value = (os.environ if environ is None else environ).get(VAR)
    if value is None:
        return None
    names = [part.strip().lower() for part in value.split(",")]
    if not all(UUID.fullmatch(name) for name in names) or len(set(names)) != len(names):
        raise AllowlistError("use a comma-separated list of distinct, full NVIDIA GPU UUIDs")
    devices = nvidia_gpu_uuids()
    by_uuid = {uuid.lower(): uuid for uuid in devices.values()}
    missing = [name for name in names if name not in by_uuid]
    if missing:
        raise AllowlistError(f"NVIDIA GPU UUIDs are not visible to nvidia-smi: {', '.join(missing)}")
    return Allowlist(devices, tuple(by_uuid[name] for name in names))


def config_env(env: dict, overrides: dict, policy: Allowlist | None, selected=None) -> dict:
    overrides = {str(key): str(value) for key, value in overrides.items()}
    if os.name == "nt" and policy is not None:
        overrides = {key.upper(): value for key, value in overrides.items()}
    if any((key.upper() if os.name == "nt" else key) == VAR for key in overrides):
        raise AllowlistError(f"set {VAR} in the environment before starting Strata")
    env.update(overrides)
    if policy is None:
        return env
    if MASK in overrides and selected is not None and policy.resolve(overrides[MASK]) != policy.resolve(selected):
        raise AllowlistError(f"{MASK} conflicts with the GPU selection in the model configuration")
    return policy.restrict_env(env, selected)


def prepare_engine_args(args: list[str], env: dict, policy: Allowlist) -> list[str]:
    """Keep the engine's legacy --gpu option from replacing the UUID mask."""
    result = []
    items = iter(args)
    for arg in items:
        if arg == "--gpu" or arg.startswith("--gpu="):
            value = next(items, None) if arg == "--gpu" else arg.split("=", 1)[1]
            if value is None or policy.resolve(value) != policy.resolve(env[MASK]):
                raise AllowlistError("engine --gpu conflicts with its CUDA mask; set gpu in the Strata run config")
        elif arg == "--gpus":                          # DeepSeek takes local CUDA ordinals
            value = next(items, "")
            count = len(policy.resolve(env[MASK]))
            if not re.fullmatch(r"[0-9]+(?:\s*,\s*[0-9]+)*", value) or any(int(i) >= count for i in value.split(",")):
                raise AllowlistError(f"engine --gpus {value!r} is outside its {count} CUDA-visible devices")
            result.extend((arg, value))
        else:
            result.append(arg)
    return result
