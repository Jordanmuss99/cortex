// The reflection utilities run under Bun, while the main Cortex build runs
// under Node. Keep the narrow Bun SQLite surface they use visible to tsc
// without pulling Bun's full runtime type package into the production image.
declare module "bun:sqlite" {
  export interface Statement<Row = unknown> {
    all(...bindings: unknown[]): Row[];
  }

  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    query<Row = unknown>(sql: string): Statement<Row>;
    close(throwOnError?: boolean): void;
  }
}
