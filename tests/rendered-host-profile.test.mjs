// A Rendered host feature may be true only where every command it invokes is registered on that
// host (src/ipc-hosts.ts COMMAND_HOSTS): one TS bundle serves both windows, a command the shell
// lacks rejects at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_HOSTS } from '../src/ipc-hosts.ts';
import { HOST_FEATURES, FEATURE_COMMANDS } from '../src/panels/rendered/host-profile.ts';

const CRATE = { 'vidar-tab': 'vidar', 'falcon-shell': 'falcon' };

test('a host feature is true only where its commands are registered', () => {
  for (const [host, features] of Object.entries(HOST_FEATURES)) {
    for (const [feature, on] of Object.entries(features)) {
      if (!on) continue;
      for (const cmd of FEATURE_COMMANDS[feature]) {
        const where = COMMAND_HOSTS[cmd];
        assert.ok(where, `${feature} names unknown command ${cmd}`);
        assert.ok(where === 'both' || where === CRATE[host], `${feature} is on for ${host} but ${cmd} is registered for ${where}`);
      }
    }
  }
});

test('every feature has a command list and a value on every host', () => {
  for (const features of Object.values(HOST_FEATURES)) {
    assert.deepEqual(Object.keys(features).sort(), Object.keys(FEATURE_COMMANDS).sort());
  }
});
