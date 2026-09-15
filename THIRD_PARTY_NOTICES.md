# Third-party notices

Forge UI behavior is source-derived from Comet/Zeron commit
`a1adfde23448a0e04256931d64a7c72a95b11db7`. The provider marks in
`apps/web/src/assets/providers/` come from that commit's `crates/ui/assets/icons/`.
Workspace path validation, text rules, search ranking, and limits in
`apps/server/src/workspace/` also follow that commit.
This notice records the upstream MIT terms for those assets and the source-derived work.

Forge also ships provider-native adapters and the pinned Cursor SDK sidecar.
The release packager includes the corresponding notices beside the packaged
server and sidecar. The native adapters only use their provider wire formats.
They do not include provider executables or credentials.

## Comet/Zeron

MIT License

Copyright (c) 2026 Wing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
