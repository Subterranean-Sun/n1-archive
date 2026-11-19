#!/usr/bin/env python3
"""Publish verified originals through an idempotent GitHub draft release.

Uses only the hosted runner's GH_TOKEN supplied by the workflow. Existing public
assets are never overwritten. A draft is published only after all required assets
have the expected byte count and SHA256 (GitHub asset digest or download check).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from restore_snapshot import (
    ARCHIVE_MANIFEST_SHA256, MANIFEST_SHA256, OWNER, sha256_file,
    validate_manifest,
)

REPOSITORY = OWNER + '/n1-archive'
TAG = 'v2026-11-19'
RELEASE_ID = None


def gh_api(endpoint: str, method: str = 'GET', fields: dict | None = None, allow_404: bool = False):
    args = ['gh', 'api', endpoint, '--method', method]
    for key, value in (fields or {}).items():
        args.extend(['-F' if isinstance(value, bool) else '-f', key + '=' + (str(value).lower() if isinstance(value, bool) else str(value))])
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        if allow_404 and '(HTTP 404)' in result.stderr:
            return None
        raise RuntimeError(f'gh API {method} {endpoint} failed: {result.stderr.strip()}')
    return json.loads(result.stdout) if result.stdout.strip() else None


def release():
    global RELEASE_ID
    if RELEASE_ID is not None:
        return gh_api(f'repos/{REPOSITORY}/releases/{RELEASE_ID}')
    current = gh_api(f'repos/{REPOSITORY}/releases/tags/{TAG}', allow_404=True)
    if current is None:
        # Drafts can exist before their git tag exists; the by-tag endpoint may
        # return 404. The authenticated releases list includes accessible drafts.
        page = 1
        while True:
            batch = gh_api(f'repos/{REPOSITORY}/releases?per_page=100&page={page}')
            candidates = [x for x in batch if x['tag_name'] == TAG]
            if len(candidates) > 1:
                raise RuntimeError('Multiple permanent archive drafts exist for the same tag')
            if candidates:
                current = candidates[0]
                break
            if len(batch) < 100:
                break
            page += 1
    if current is not None:
        RELEASE_ID = current['id']
    return current


def verify_asset(asset: dict, local: Path, digest: str) -> bool:
    if asset.get('size') != local.stat().st_size:
        return False
    reported = asset.get('digest')
    if reported:
        return reported.lower() == 'sha256:' + digest
    # Some older release objects omit digest. Stream through authenticated gh;
    # never place authentication data in a URL or print it.
    with tempfile.TemporaryDirectory(prefix='n1-release-verify-') as temporary:
        copy = Path(temporary) / 'asset.bin'
        with copy.open('wb') as target:
            response = subprocess.run([
                'gh', 'api', f'repos/{REPOSITORY}/releases/assets/{asset["id"]}',
                '-H', 'Accept: application/octet-stream',
            ], stdout=target, stderr=subprocess.PIPE)
        if response.returncode:
            raise RuntimeError('Authenticated release asset verification download failed')
        return sha256_file(copy) == digest


def ensure_asset(name: str, local: Path, digest: str) -> None:
    for attempt in range(1, 4):
        state = release()
        assets = [x for x in state['assets'] if x['name'] == name]
        if len(assets) > 1:
            raise RuntimeError(f'Duplicate release asset name: {name}')
        if assets:
            if verify_asset(assets[0], local, digest):
                print('Verified release asset ' + name, flush=True)
                return
            if not state['draft']:
                raise RuntimeError(f'Existing published asset differs; refusing to overwrite {name}')
            gh_api(f'repos/{REPOSITORY}/releases/assets/{assets[0]["id"]}', method='DELETE')
        if not state['draft']:
            raise RuntimeError(f'Published release lacks required asset {name}; refusing to mutate it')
        response = subprocess.run(['gh', 'release', 'upload', TAG, str(local), '--repo', REPOSITORY], text=True, capture_output=True)
        # Re-query on the next iteration even after a failed command, since the
        # server may have received the asset before the network response failed.
        if response.returncode:
            print(f'Asset upload attempt {attempt} needs verification/retry: {name}', flush=True)
        else:
            state = release()
            current = next((x for x in state['assets'] if x['name'] == name), None)
            if current and verify_asset(current, local, digest):
                print('Uploaded and verified ' + name, flush=True)
                return
        if attempt < 3:
            time.sleep(5 * attempt)
    raise RuntimeError(f'Asset upload did not finish with a verified digest: {name}')


def main():
    global RELEASE_ID
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise RuntimeError('Archive publication is restricted to the intended repository')
    manifest_path = args.work_dir / 'transport-manifest.json'
    if sha256_file(manifest_path) != MANIFEST_SHA256:
        raise RuntimeError('Local transport manifest is not the pinned snapshot')
    manifest = json.loads(manifest_path.read_text('utf-8'))
    validate_manifest(manifest)
    archive_manifest = args.work_dir / 'archive-manifest.json'
    if sha256_file(archive_manifest) != ARCHIVE_MANIFEST_SHA256:
        raise RuntimeError('Original archive manifest digest differs')
    required = {}
    for target in ['original-materials', 'original-answers']:
        record = manifest['targets'][target]
        package = args.work_dir / 'packages' / record['fileName']
        if package.stat().st_size != record['totalBytes'] or sha256_file(package) != record['sha256']:
            raise RuntimeError('Original archive package digest differs: ' + target)
        required[package.name] = (package, record['sha256'])
    # The transport keeps its descriptive name, while the permanent release's
    # public link has always been documented as manifest.json.
    permanent_manifest = args.work_dir / 'manifest.json'
    shutil.copyfile(archive_manifest, permanent_manifest)
    required['manifest.json'] = (permanent_manifest, ARCHIVE_MANIFEST_SHA256)
    current = release()
    if current is None:
        current = gh_api(f'repos/{REPOSITORY}/releases', method='POST', fields={
            'tag_name': TAG, 'target_commitish': 'main',
            'name': 'N1 original materials and answers 2010-2026',
            'body': 'Original source archives for the N1 study site. All assets are verified against the pinned 2026-11-19 transport manifest. See manifest.json for file-level SHA256 and CRC32 records.',
            'draft': True, 'prerelease': False,
        })
        RELEASE_ID = current['id']
    for name, (local, digest) in required.items():
        ensure_asset(name, local, digest)
    current = release()
    # Independently check the complete required set immediately before exposing it.
    for name, (local, digest) in required.items():
        asset = next((x for x in current['assets'] if x['name'] == name), None)
        if asset is None or not verify_asset(asset, local, digest):
            raise RuntimeError('Final release digest verification failed: ' + name)
    if current['draft']:
        current = gh_api(f'repos/{REPOSITORY}/releases/{current["id"]}', method='PATCH', fields={'draft': False})
    if current['draft']:
        raise RuntimeError('Archive release remained a draft')
    print(json.dumps({'release': current['html_url'], 'tag': TAG, 'verifiedAssets': sorted(required)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
