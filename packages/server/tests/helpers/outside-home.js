// A directory, and a file, that are genuinely OUTSIDE $HOME on THIS platform
// (#7273, hoisted for #7285).
//
// Both of the obvious POSIX choices are wrong on Windows: `/etc` does not exist
// at all, and `os.tmpdir()` is INSIDE the user profile there
// (`C:\Users\x\AppData\Local\Temp`, or under
// `C:\Windows\ServiceProfiles\NetworkService` for the CI runner's account). A
// fixture built on either tests nothing: it fails on a missing path, or it
// builds an "outside" target that is not outside, instead of exercising the
// containment rule it means to. %SystemRoot% is outside the profile on every
// Windows install, including the runner's (whose profile sits UNDER it), and
// ships the hosts file at a stable location.
//
// Both are READ-ONLY targets: link to them, list them, validate against them,
// but never write into them. The runner's account cannot write to %SystemRoot%,
// and on POSIX nobody should be writing to /etc.
//
// Using a real out-of-home path rather than skipping keeps these assertions
// LOAD-BEARING on Windows, which is the point: several of them previously
// passed on Windows only because the containment check denied everything, and
// would have kept passing had the check been removed entirely.

import { join } from 'node:path'

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'

export const OUTSIDE_HOME_DIR = process.platform === 'win32'
  ? SYSTEM_ROOT
  : '/etc'

export const OUTSIDE_HOME_FILE = process.platform === 'win32'
  ? join(SYSTEM_ROOT, 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts'
