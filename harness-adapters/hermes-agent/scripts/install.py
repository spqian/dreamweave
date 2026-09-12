#!/usr/bin/env python3
"""Stage the Hermes adapter; never initialize data, alter models, or schedule jobs."""
import argparse
import json
import os
from pathlib import Path
import sys
import shutil
import uuid

from dreamweave_harness import Refused, atomic_text, require, require_supported_platform


def install(home, engine, daily_dir, entry_target=200, memory_char_limit=2200, upgrade=False):
    require_supported_platform()
    home, engine, daily_dir = (Path(p).expanduser().resolve() for p in (home, engine, daily_dir))
    require((engine / 'src/dream.js').is_file() and (engine / 'src/recall.js').is_file(),
            'engine must be a Dreamweave code root containing src/dream.js and src/recall.js')
    require(daily_dir.is_dir(), 'daily directory must already exist; no evidence directory is created implicitly')
    require(entry_target > 0 and memory_char_limit > 0, 'budgets must be positive')
    adapter = Path(__file__).resolve().parents[1]
    files = {Path('scripts') / name: (adapter / 'scripts' / name).read_text(encoding='utf-8')
             for name in ('dreamweave_harness.py', 'adapter-snapshot.js', 'dreamweave.py')}
    for source in sorted((adapter / 'skills').rglob('*')):
        if source.is_file():
            files[Path('skills/memory') / source.relative_to(adapter / 'skills')] = source.read_text(encoding='utf-8')
    config = dict(version=1, engine=str(engine), daily_dir=str(daily_dir),
                  entry_target=entry_target, memory_char_limit=memory_char_limit)
    files[Path('dreamweave-adapter.json')] = json.dumps(config, indent=2) + '\n'
    for relative in [*files, Path('dreamweave-adapter-backups')]:
        target = home / relative
        require(target.resolve().is_relative_to(home) and
                not any(p.is_symlink() for p in [target, *target.parents] if p != home and home in p.parents),
                f'symlink installation destination refused: {relative}')
    changed = {p: content for p, content in files.items()
               if not (home / p).exists() or (home / p).read_text(encoding='utf-8') != content}
    conflicts = [p for p in changed if (home / p).exists()]
    require(upgrade or not conflicts,
            f'existing files preserved: {conflicts}; inspect them and use --upgrade to back up and replace')
    backups = []
    backup_root = home / 'dreamweave-adapter-backups' / uuid.uuid4().hex
    # Back up every differing existing artifact before replacing any of them.
    for relative in conflicts:
        dest = backup_root / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(home / relative, dest)
        backups.append(str(dest))
    for relative, content in changed.items():
        atomic_text(home / relative, content)
    return {'installed': [str(home / p) for p in changed], 'hermes_home': str(home), 'backups': backups,
            'config': config, 'database_initialized': False, 'cron_created': False,
            'models_changed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-home', type=Path, default=os.environ.get('HERMES_HOME', Path.home() / '.hermes'))
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--daily-dir', type=Path, required=True)
    parser.add_argument('--entry-target', type=int, default=200)
    parser.add_argument('--memory-char-limit', type=int, default=2200)
    parser.add_argument('--upgrade', action='store_true', help='back up differing existing adapter files before replacement')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.hermes_home, args.engine, args.daily_dir,
                                 args.entry_target, args.memory_char_limit, args.upgrade)))
    except (Refused, OSError, ValueError, TypeError) as e:
        print(json.dumps({'complete': False, 'error': str(e)}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
