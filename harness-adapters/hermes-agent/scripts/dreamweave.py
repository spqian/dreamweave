#!/usr/bin/env python3
"""Explicit initialization, diagnostics, and graph recall for the selected Hermes profile.

Nightly judgment and projection belong to dreamweave_harness.py, not this wrapper.
"""
import argparse
import json
import subprocess
import sys
from dreamweave_harness import Harness, Refused


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('init', 'doctor', 'stats', 'budget', 'recall'))
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        harness = Harness()
        script = harness.engine / ('src/recall.js' if args.command == 'recall' else 'src/dream.js')
        argv = ['node', str(script)]
        if args.command != 'recall':
            argv.append(args.command)
        argv.extend(args.arguments)
        with harness.lock():
            result = subprocess.run(argv, env=harness.env)
            if args.command == 'init' and result.returncode == 0:
                harness.memory.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with harness.memory.open('x', encoding='utf-8'):
                        pass
                except FileExistsError:
                    pass  # Initialization never replaces existing observations.
            return result.returncode
    except (Refused, OSError, ValueError, TypeError) as e:
        print(json.dumps({'complete': False, 'error': str(e)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
