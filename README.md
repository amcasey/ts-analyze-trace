# ts-analyze-trace
Tool for analyzing the output of `tsc --generateTrace` automatically, rather than following the steps [here](https://github.com/microsoft/TypeScript/wiki/Performance-Tracing).

Note: The goal is to identify clear-cut hot-spots and provide enough context to extract a small repro.
The repro can then be used as the basis of a bug report or a starting point for manual code inspection or profiling.

## Usage

First, build your project with `--generateTrace traceDir`.  Then, run `npx ts-analyze-trace traceDir` to see a sorted list of compilation hot-spots.

## Extras

You can invoke `analyze-trace` directly to analyze a single trace (optionally, with types), rather than a whole directory.

You can use `normalize-positions` to convert file offsets to line-character pairs and skip past trivia (whitespace, comments, etc).