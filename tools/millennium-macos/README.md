# Millennium patches for macOS

Apply on top of Millennium PR [#841](https://github.com/SteamClientHomebrew/Millennium/pull/841) (head `35418d28`) to get plugin JS patches working on the macOS client. Without `0001`, no Steam Discreet hook attaches on Mac.

- `0001`: hooks `cef_browser_host_create_browser` on Apple Silicon, hands the browser Helper the patch-list IPC pipes, and fixes the `steamui` path. See "macOS" in `docs/research.md`.
- `0002`: upstream commit `2c15d5ba` (sidebar crash fix), which PR 841 predates.

```sh
git clone https://github.com/SteamClientHomebrew/Millennium.git && cd Millennium
git fetch origin pull/841/head && git checkout 35418d28
git submodule update --init --recursive
git am /path/to/steam-discreet/tools/millennium-macos/*.patch
CC=$(brew --prefix llvm)/bin/clang CXX=$(brew --prefix llvm)/bin/clang++ cmake --preset=osx-release -DMILLENNIUM_RUN_TESTS_ON_BUILD=OFF
cmake --build build/osx-release
scripts/macos/install_macos.sh --runtime-build-dir build/osx-release --wrapper-build-dir build/osx-release
```

Not published upstream.
