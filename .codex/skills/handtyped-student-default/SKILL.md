---
name: handtyped-student-default
description: Use when working in the Handtyped repository, especially when choosing between student and non-student app surfaces, packages, binaries, configs, tests, or release artifacts.
metadata:
  short-description: Treat Handtyped student version as default
---

# Handtyped Student Default

In this repository, the default Handtyped target is the student version.

When a user asks for Handtyped changes without specifying a product variant:

- Treat the student version as the intended target.
- Prefer files, commands, tests, configs, and release artifacts that belong to the student app.
- Do not modify the non-student version unless the user specifically asks for non-student, teacher, legacy, base, or general app changes that clearly require it.
- If a requested change appears to affect both student and non-student behavior, pause long enough to identify the split and keep edits scoped to the student side unless the user explicitly broadens the scope.
