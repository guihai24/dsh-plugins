#!/usr/bin/env python3
"""Generate the format-1 plugin market index for this repository.

Usage: python3 scripts/build-index.py [commit]

The commit defaults to the current HEAD. Every plugin under packages/ becomes an
entry whose single version is pinned to that commit, so `index.json` must be
regenerated and committed after every release.
"""
import base64
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO_URL = 'https://github.com/guihai24/dsh-plugins'
DIST_RANGE = '>=0.2.1-rc.2 <0.3.0-0'
AUTHOR = 'guihai24'


def commit_sha():
    if len(sys.argv) > 1:
        return sys.argv[1]
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def read_locale(package_dir, locale):
    meta = json.loads((package_dir / 'locale' / f'{locale}.json').read_text(encoding='utf-8'))['meta']
    return meta['title'], meta['description']


def build_plugin(package_dir, commit):
    manifest = json.loads((package_dir / 'package.json').read_text(encoding='utf-8'))
    zh_title, zh_desc = read_locale(package_dir, 'zh')
    en_title, en_desc = read_locale(package_dir, 'en')
    icon = 'data:image/svg+xml;base64,' + base64.b64encode(
        (package_dir / 'icon.svg').read_bytes()).decode('ascii')
    relative = package_dir.relative_to(ROOT).as_posix()
    return {
        'name': manifest['name'],
        'title': {'zh': zh_title, 'en': en_title},
        'description': {'zh': zh_desc, 'en': en_desc},
        'icon': icon,
        'author': AUTHOR,
        'homepage': f'{REPO_URL}/tree/main/{relative}',
        'repository': {'url': REPO_URL, 'directory': relative},
        'metadata': {
            'keywords': manifest.get('keywords', []),
            'labels': [],
            'sortKeys': {},
        },
        'versions': [
            {
                'version': manifest['version'],
                'publishTimestamp': int(time.time()),
                'source': {
                    'type': 'git',
                    'url': REPO_URL,
                    'commit': commit,
                    'path': relative,
                },
                'engines': {'dsh': DIST_RANGE},
            }
        ],
    }


def main():
    commit = commit_sha()
    plugins = [
        build_plugin(package_dir, commit)
        for package_dir in sorted((ROOT / 'packages').iterdir())
        if (package_dir / 'package.json').is_file()
    ]
    index = {
        'format': 1,
        'title': {'zh': 'guihai24 的 DSH 插件', 'en': "guihai24's DSH plugins"},
        'description': {
            'zh': 'Antigravity（agy）与 WorkBuddy（codebuddy）一次性子智能体后端。',
            'en': 'One-shot Antigravity (agy) and WorkBuddy (codebuddy) subagent backends for DeepSeek Harness.',
        },
        'metadata': {},
        'plugins': plugins,
    }
    out = ROOT / 'index.json'
    out.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'wrote {out} ({len(plugins)} plugins, commit {commit})')


if __name__ == '__main__':
    main()
