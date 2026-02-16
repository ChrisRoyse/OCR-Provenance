# Contributing

Thank you for your interest in contributing to OCR Provenance MCP Server.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/OCR-Provenance.git
   cd OCR-Provenance
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy the environment template:
   ```bash
   cp .env.example .env
   # Fill in your API keys
   ```
5. Build the project:
   ```bash
   npm run build
   ```
6. Run the tests:
   ```bash
   npm test
   ```

## Development Workflow

1. Create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Run the full check suite:
   ```bash
   npm run check
   ```
   This runs type checking, linting, and tests.
4. Commit your changes with a clear message
5. Push and open a pull request

## Code Standards

### TypeScript (src/)
- All public APIs must have typed interfaces
- Use `eslint` and `prettier` for formatting:
  ```bash
  npm run lint:fix
  npm run format
  ```
- **Never use `console.log()` in source code** - stdout is reserved for JSON-RPC protocol communication. Use `console.error()` for debug logging.

### Python (python/)
- Use `ruff` for linting and formatting:
  ```bash
  npm run lint:py:fix
  ```
- Python workers communicate via JSON on stdout
- All workers must handle errors gracefully and return JSON error responses

### Tests
- Write tests for new features and bug fixes
- Tests use [Vitest](https://vitest.dev/)
- Test files go in `tests/unit/` or `tests/integration/`
- Run tests: `npm test`
- Run with watch mode: `npm run test:watch`

## Project Structure

```
src/
  index.ts              # MCP server entry point
  models/               # Data models and types
  services/             # Core business logic
    chunking/           # Text chunking
    embedding/          # GPU embedding generation
    gemini/             # Gemini AI integration
    images/             # Image extraction
    ocr/                # OCR processing
    provenance/         # Provenance chain tracking
    storage/            # SQLite database + vector storage
    vlm/                # Vision-language model pipeline
  tools/                # MCP tool handlers (104 tools)
  utils/                # Shared utilities
python/                 # Python workers
tests/
  unit/                 # Unit tests
  integration/          # Integration tests
  manual/               # Manual verification tests
scripts/                # Utility scripts
```

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Ensure all tests pass (`npm test`)
- Ensure the build succeeds (`npm run build`)
- Ensure linting passes (`npm run lint`)
- Update documentation if you change public APIs or add tools

## Adding New MCP Tools

1. Create or edit a tool file in `src/tools/`
2. Define your tool using the `ToolDefinition` interface from `src/tools/shared.ts`
3. Register the tool in `src/index.ts`
4. Add tests in `tests/unit/tools/`
5. Use shared helpers from `src/tools/shared.ts` (e.g., `formatResponse`, `handleError`)

## Reporting Issues

- Use [GitHub Issues](https://github.com/ChrisRoyse/OCR-Provenance/issues)
- Include steps to reproduce, expected behavior, and actual behavior
- Include your Node.js version and operating system

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
