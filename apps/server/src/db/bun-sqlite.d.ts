declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string)
    exec(sql: string): void
  }
}
