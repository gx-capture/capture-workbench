"""Authenticated immutable contract discovery routes."""

from __future__ import annotations

import base64
from hashlib import sha256

from fastapi import APIRouter, Path, Request, Response

from capture_runtime.contract_set import CONTRACT_MEDIA_TYPE, ContractSet
from capture_runtime.routes.common import ApiProblem


def _integrity_headers(contract_set: ContractSet) -> dict[str, str]:
    digest_bytes = bytes.fromhex(contract_set.sha256)
    digest_b64 = base64.b64encode(digest_bytes).decode("ascii")
    return {
        "ETag": contract_set.etag,
        "Digest": f"sha-256={digest_b64}",
        "X-Contract-SHA256": contract_set.sha256,
        "Cache-Control": "public, max-age=31536000, immutable",
    }


def _matches_etag(request: Request, etag: str) -> bool:
    supplied = request.headers.get("if-none-match")
    if supplied is None:
        return False
    for candidate in supplied.split(","):
        normalized = candidate.strip()
        if normalized == "*":
            return True
        if normalized.startswith("W/"):
            normalized = normalized[2:]
        if normalized == etag:
            return True
    return False


def _response(
    request: Request,
    contract_set: ContractSet,
    content: bytes,
    *,
    status_code: int = 200,
) -> Response:
    headers = _integrity_headers(contract_set)
    if _matches_etag(request, contract_set.etag):
        return Response(status_code=304, headers=headers)
    return Response(
        content=content,
        status_code=status_code,
        media_type=CONTRACT_MEDIA_TYPE,
        headers=headers,
    )


def register_contract_routes(router: APIRouter, contract_set: ContractSet) -> None:
    """Register the small index and exact immutable contract bundle endpoint."""

    @router.get("/contracts")
    async def contract_index(request: Request) -> Response:
        return _response(request, contract_set, contract_set.index_bytes)

    @router.get("/contracts/sha256/{digest}")
    async def contract_bundle(
        request: Request,
        digest: str = Path(min_length=64, max_length=64),
    ) -> Response:
        if digest != contract_set.sha256:
            raise ApiProblem(404, "contract_bundle_not_found", "Contract bundle was not found.")
        # Recompute the digest at the serving boundary.  This protects the
        # immutable route if an embedding host accidentally mutates the bytes
        # supplied by a custom ContractSet implementation.
        if sha256(contract_set.bundle_bytes).hexdigest() != digest:
            raise ApiProblem(500, "contract_bundle_integrity", "Contract bundle integrity failed.")
        return _response(request, contract_set, contract_set.bundle_bytes)


__all__ = ["register_contract_routes"]
