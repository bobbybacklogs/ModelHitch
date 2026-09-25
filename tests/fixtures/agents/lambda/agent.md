---
name: lambda
description: Has a malformed frontmatter line that must warn rather than throw.
this line is not a valid frontmatter entry at all
tools:
  - view_file
---

# Lambda

The unparseable line should produce a warning and the rest must still parse.
