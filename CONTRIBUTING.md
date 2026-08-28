# Contributing to CORTEX

Thank you for your interest in contributing to CORTEX.

## Getting Started

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Run type check (`npm run typecheck`)
6. Commit with a clear message
7. Open a pull request

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/cortex.git
cd cortex
npm install
cp .env.example .env
# Fill in your DATABASE_URL and at least one embedding API key
# Schema-dependent work uses the guarded disposable harness; never point it at
# a shared or live database.
npm run test:oauth:integration
npm test
```

## Code Guidelines

- TypeScript strict mode
- No hardcoded API keys, paths, or personal data
- New features should include tests
- Database changes use ordered, checked-in SQL under `db/migrations/` and the locked/checksummed migration runner; application runtimes never execute DDL
- MCP tools should have clear descriptions and typed parameters via Zod

## Migration authority and safety

- Schema and privilege changes run only through the one-shot migration/preparation process with a database-owner credential. Core, worker, MCP, cron, OAuth gateway, and operator runtimes must not receive owner credentials or create/alter/drop database objects.
- Every checked-in migration must be in the required ordered set, pass preflight before any mutation, execute transactionally, and record its exact checksum in the migration ledger. Tests must use the guarded disposable database harness, never a developer or live Cortex database.
- OAuth migration `009` is immutable at SHA-256 `e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80`. Never edit, rename, reorder, or replace it. An OAuth correction must use the next coordinated unused migration number.
- Memory migration `010` currently has SHA-256 `c41cdcbd0bdef50d673dbb19bbdea47403d4b8e8981c7d2438f6a1ead8789df5`, but remains intentionally mutable and disposable-only until Slice 18 of the independent memory plan. Do not freeze it early, apply it to production, or weaken its exact loopback/database-identity guard.
- Coordinate migration numbering across the OAuth and memory plans before adding a file. Once a migration has been frozen or applied to production, all later fixes are new forward migrations; checksum history is never rewritten.
- Keep database credentials separated: owner/migration, OAuth gateway runtime, OAuth operator, and memory runtime are distinct authorities. Tests should assert both the required grants and the forbidden access.

## Areas We Need Help

- **Benchmarks**: LongMemEval, LOCOMO, custom memory retrieval tests
- **Entity Resolution**: Better NER, co-reference resolution, entity deduplication
- **Temporal Reasoning**: Timeline queries, "what changed since?" APIs
- **Graph Visualization**: D3/Three.js memory network explorer
- **Providers**: Additional embedding model support, local LLM integration
- **Tests**: Expand coverage beyond hippocampus/entities/chunker

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
