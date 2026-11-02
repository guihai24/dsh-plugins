#!/usr/bin/env python3
"""Generate the format-1 plugin market index for this repository.

Usage:
    python3 scripts/build-index.py [--npm] [commit]

Without --npm every plugin version is a `git` source pinned to `commit`
(default: current HEAD), so regenerate and commit after every release.
With --npm the source is the package's npm release; publish first, then rerun.
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
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def read_locale(package_dir, locale):
    meta = json.loads((package_dir / 'locale' / f'{locale}.json').read_text(encoding='utf-8'))['meta']
    return meta['title'], meta['description']


def build_plugin(package_dir, use_npm, commit):
    manifest = json.loads((package_dir / 'package.json').read_text(encoding='utf-8'))
    zh_title, zh_desc = read_locale(package_dir, 'zh')
    en_title, en_desc = read_locale(package_dir, 'en')
    icon = 'data:image/svg+xml;base64,' + base64.b64encode(
        (package_dir / 'icon.svg').read_bytes()).decode('ascii')
    relative = package_dir.relative_to(ROOT).as_posix()
    source = {'type': 'npm'} if use_npm else {
        'type': 'git',
        'url': REPO_URL,
        'commit': commit,
        'path': relative,
    }
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
                'source': source,
                'engines': {'dsh': DIST_RANGE},
            }
        ],
    }


def main():
    args = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
    use_npm = '--npm' in sys.argv
    commit = args[0] if args else commit_sha()
    plugins = [
        build_plugin(package_dir, use_npm, commit)
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
    mode = 'npm' if use_npm else f'git@{commit[:12]}'
    print(f'wrote {out} ({len(plugins)} plugins, source {mode})')


if __name__ == '__main__':
    main()
