# Contributing to OXIS

Thanks for your interest in contributing to **OXIS**.

OXIS is an open-source programmable workspace designed to bring workflows, automation, documents, browser-rendered interfaces, and system control into one extensible environment.

Whether you're fixing a bug, improving the core, building a Lua plugin, improving documentation, or suggesting an idea, contributions are welcome.

---

## Ways You Can Contribute

There are several ways to contribute to OXIS:

* 🐛 Report bugs
* 💡 Suggest features and improvements
* 🔧 Fix bugs or improve existing functionality
* ⚡ Improve performance and reliability
* 🧩 Build Lua plugins
* 📚 Improve documentation
* 🎨 Improve the user experience and interface
* 🧪 Add tests
* 🔍 Review merge requests
* 🛠️ Improve developer tooling

---

## Before You Start

Please check the existing issues and merge requests before starting major work.

For larger changes, it is recommended that you open an issue first so the proposed change can be discussed before significant development begins.

Small fixes, documentation improvements, and straightforward bug fixes can generally be submitted directly as a merge request.

---

## Development Workflow

### 1. Fork or clone the repository

Clone your copy of OXIS:

```bash
git clone https://github.com/REPLACE_WITH_YOUR_GITHUB_OWNER/REPLACE_WITH_YOUR_REPO_NAME.git
cd OXIS
```

### 2. Create a branch

Please avoid making changes directly on `main`.

Create a descriptive branch:

```bash
git checkout -b feature/my-feature
```

Examples:

```text
feature/workspace-improvements
feature/new-command
fix/plugin-loading
fix/browser-rendering
docs/update-readme
plugin/example-plugin
```

### 3. Make your changes

Keep changes focused and avoid modifying unrelated parts of the project.

Before submitting a merge request:

* Make sure the project still builds
* Make sure existing functionality still works
* Test the functionality you changed
* Remove unnecessary debug code
* Keep code readable
* Update documentation when necessary

### 4. Commit your changes

Use clear commit messages.

Examples:

```bash
git add .
git commit -m "Add workspace command"
```

```bash
git commit -m "Fix Lua plugin loading"
```

```bash
git commit -m "Update plugin documentation"
```

### 5. Push your branch

```bash
git push origin feature/my-feature
```

### 6. Open a Merge Request

Open a **Merge Request** on GitLab.

Your merge request should explain:

* What you changed
* Why you changed it
* How you tested it
* Any important limitations or considerations

For example:

```text
## What changed

Added support for loading Lua plugins from the workspace.

## Why

This makes it easier for users to extend OXIS with their own commands.

## Testing

- Tested plugin installation
- Tested plugin loading
- Tested plugin removal
- Tested existing commands

## Notes

No existing commands were changed.
```

---

# Lua Plugins

OXIS is designed to be extensible through Lua.

If you want to create a plugin, you can develop it independently and submit it for inclusion in the OXIS plugin ecosystem.

Plugins should:

* Have a clear purpose
* Work with the documented OXIS plugin API
* Avoid unnecessary dependencies
* Avoid collecting user data without clearly communicating it
* Avoid malicious or destructive behavior
* Include documentation
* Follow the plugin structure and conventions
* Be tested before submission

A plugin should not interfere with unrelated OXIS functionality.

---

## Submitting a Plugin

Create your plugin in your own fork or plugin repository and submit a Merge Request when it is ready.

A plugin submission should include:

```text
plugin-name/
├── plugin.lua
├── README.md
└── assets/
    └── ...
```

The exact structure may change as the OXIS plugin API evolves.

Your plugin README should explain:

* What the plugin does
* Installation instructions
* Available commands/features
* Configuration options
* Required permissions or system access
* Dependencies
* License

Do not submit private keys, passwords, API keys, tokens, or other secrets.

---

# OXIS Market

OXIS Market is intended to provide a place for users to discover and install OXIS plugins.

Community-created plugins may be submitted for consideration for inclusion in the Market.

Free and subscription-based plugins may have different requirements. Market submission does not automatically guarantee acceptance.

Paid plugins and their commercial terms are handled separately from the open-source OXIS core.

---

# Code Quality

Please keep contributions consistent with the existing project.

Prefer:

* Clear names
* Small, focused functions
* Simple implementations
* Helpful comments where necessary
* Reusable code
* Proper error handling

Avoid:

* Unnecessary complexity
* Large unrelated changes
* Dead code
* Debug prints
* Hard-coded secrets
* Breaking existing functionality without discussion

---

# Documentation

Documentation improvements are always welcome.

If you add or change a feature, update the relevant documentation when appropriate.

This includes:

* README documentation
* Command documentation
* Plugin documentation
* Configuration documentation
* Examples
* Developer documentation

Good documentation makes OXIS easier for both users and contributors to understand.

---

# Bug Reports

When reporting a bug, provide as much useful information as possible.

Please include:

* OXIS version
* Operating system
* Steps to reproduce the problem
* Expected behavior
* Actual behavior
* Relevant error messages
* Screenshots or logs when useful

A good bug report makes it easier to reproduce and fix the problem.

---

# Feature Requests

Feature requests are welcome.

Please explain:

* What you would like to add
* What problem it solves
* How you expect it to work
* Why it would be useful

For larger features, discussion before implementation is encouraged.

---

# Security Issues

**Please do not publicly report security vulnerabilities through regular issues.**

If you discover a security vulnerability that could affect OXIS or its users, contact the project maintainers privately before publicly disclosing the issue.

Do not include sensitive exploit details in a public issue.

---

# Pull Requests / Merge Requests

Before submitting a Merge Request, please make sure:

* [ ] The project builds successfully
* [ ] The change has been tested
* [ ] Existing functionality still works
* [ ] Documentation has been updated where necessary
* [ ] No secrets or credentials are included
* [ ] The Merge Request has a clear description
* [ ] The changes are limited to the intended purpose

Maintainers may request changes before a Merge Request is merged.

Not every contribution will necessarily be accepted. Changes may be declined if they conflict with the project's direction, introduce unnecessary complexity, create security concerns, or negatively affect existing functionality.

---

# Community Standards

Please keep contributions constructive and respectful.

We want OXIS to be a place where developers can experiment, build, learn, and contribute.

Harassment, personal attacks, spam, malicious contributions, and intentionally disruptive behavior are not welcome.

---

# License

By contributing to OXIS, you agree that your contributions may be distributed under the project's applicable license.

Please see the [`LICENSE`](LICENSE) file for the current license of the OXIS project.

---

# Thank You

Every contribution helps improve OXIS.

Whether you're submitting a one-line documentation fix, reporting a bug, building a Lua plugin, or contributing a major feature, thank you for helping build OXIS.