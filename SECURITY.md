# Security policy

Vaka is a browser whose whole point is protecting people. Security reports are the most valuable contribution you can make.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private reporting: go to the **Security** tab of this repository and click **Report a vulnerability**. Only the maintainers can read what you send there.

Include as much as you can:

- What the vulnerability is and what an attacker could do with it.
- Steps to reproduce, ideally with a minimal page or script.
- Which Vaka version and operating system you tested on.

You will get a first reply within a few days. We will keep you updated while the fix is being made, and credit you in the release notes if you want.

## What is in scope

- The browser itself: tab isolation, the protection engine, download handling, the dangerous-site warning.
- The password manager and Vaka Wallet (both are end-to-end encrypted on the device — anything that breaks that is critical).
- The Krypto panel and the account flow inside the browser.
- Auto-update handling.

## Out of scope

- Vulnerabilities in Chromium or Electron themselves. Report those upstream; we ship the latest available builds.
- Sites that the protection engine does not block. Those are filter-list issues, not security issues — open a normal issue.
- Social engineering of maintainers, or attacks that need physical access to an unlocked machine.

## Supported versions

Only the latest release gets security fixes. The browser updates itself on Linux and Windows; macOS users download the newest build from the website.
