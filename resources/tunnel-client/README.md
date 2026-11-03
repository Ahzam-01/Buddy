# Buddy tunnel-client resource

This directory is reserved for a verified, pinned, official OpenAI tunnel-client
distribution. Buddy resolves only `linux-x64/tunnel-client`, `linux-arm64/tunnel-client`,
`mac-x64/tunnel-client`, `mac-arm64/tunnel-client`, or `win-x64/tunnel-client.exe` from
this directory (or the packaged app's resources directory). It never searches PATH.

No executable is included in this source checkout because no official OpenAI runtime
artifact was available to verify during this change. Add only a verified official binary
and its license/notice before distributing a build.
