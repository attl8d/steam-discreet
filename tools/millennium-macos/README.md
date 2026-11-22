# Millennium build for macOS

Millennium has no official macOS build. Our fix for plugin JS patches on the Mac client (formerly `0001` here) is now part of Millennium PR [#841](https://github.com/SteamClientHomebrew/Millennium/pull/841): iFleey merged it into their `macos-support` branch on 22 November 2026, together with their own fix for CDP hanging during patch transfers. Without it, no Steam Discreet hook attaches on Mac.

PR 841 is still based on v3.5.0-beta.3, so the build merges it with v3.6.3. That merge has conflicts. `git merge -X theirs` settles all but a few of them, and `v3.6.3-merge-fixup.patch` corrects the rest:

- `src/instrumentation/internal/loopback_ipc.cc`: keeps iFleey's macOS loopback code (the patch worker can be stopped when its CDP session ends). On Windows and Linux the first patch list is still sent from its own thread, as in v3.6.3 ([#947](https://github.com/SteamClientHomebrew/Millennium/issues/947)).
- `src/engine/cdp_api.cc`: restores `m_callback_pool->shutdown()`, which the merge drops.
- `tests/CMakeLists.txt`, `tests/cpp/CMakeLists.txt`: keep the macOS connector tests.
- `src/bootstrap/README.md`: one line of docs.

v3.6.3 also brings upstream commit `2c15d5ba` (sidebar crash fix), formerly `0002` here.

```sh
git clone https://github.com/SteamClientHomebrew/Millennium.git && cd Millennium
git fetch origin pull/841/head && git checkout 9d24bd9c
git -c user.name=build -c user.email=build@localhost merge --no-edit -X theirs v3.6.3
git apply /path/to/steam-discreet/tools/millennium-macos/v3.6.3-merge-fixup.patch
git submodule update --init --recursive
CC=$(brew --prefix llvm)/bin/clang CXX=$(brew --prefix llvm)/bin/clang++ cmake --preset=osx-release -DMILLENNIUM_RUN_TESTS_ON_BUILD=OFF
cmake --build build/osx-release
scripts/macos/install_macos.sh --runtime-build-dir build/osx-release --wrapper-build-dir build/osx-release
```

`9d24bd9c` is the PR 841 head on 22 November 2026. If PR 841 moves on, or is merged into a release, this recipe and the fixup patch need to be redone.
