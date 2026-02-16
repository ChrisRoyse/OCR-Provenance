# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please send an email to the repository maintainer with:

1. A description of the vulnerability
2. Steps to reproduce the issue
3. Potential impact assessment
4. Any suggested fixes (if applicable)

You can reach the maintainer through the contact information on their [GitHub profile](https://github.com/ChrisRoyse).

## What to Expect

- **Acknowledgment**: Within 48 hours of your report
- **Assessment**: Within 1 week, we'll assess the severity and confirm the vulnerability
- **Fix**: Critical vulnerabilities will be patched as soon as possible
- **Disclosure**: We'll coordinate with you on public disclosure timing

## Security Considerations

This project handles document processing and integrates with external APIs. Key security areas:

### API Keys
- Never commit API keys or secrets to the repository
- All API keys are loaded from environment variables (`.env` file)
- The `.env` file is excluded from version control via `.gitignore`

### File Processing
- File paths are sanitized to prevent directory traversal attacks
- Input validation is applied at all system boundaries
- File hashes (SHA-256) verify document integrity throughout the provenance chain

### Database
- SQLite databases are stored locally (not exposed to network)
- No SQL injection vectors (parameterized queries throughout)
- Database files are excluded from version control

### Dependencies
- Dependencies are regularly reviewed for known vulnerabilities
- Run `npm audit` to check for dependency vulnerabilities
