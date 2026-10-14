import { AsyncLocalStorage } from 'node:async_hooks';

const names = Object.fromEntries([
  'uniqueId','tokenHash','createdAt','lastSeen','traccarId','bridgeStatus',
  'offlineSeconds','speedLimit','offlineAlert','tenantId','deviceId','eventId',
  'recordedAt','receivedAt','fenceId','updatedAt','expiresAt','linkHash',
  'passwordHash','deviceName','verifiedAt','resetAt',
].map(name => [name.toLowerCase(), name]));

// Only these two legacy SQLite statements are accepted. All other statements
// must already use PostgreSQL syntax. This is not a SQLite SQL translator.
const relayDDL = `CREATE TABLE IF NOT EXISTS relay_installations(deviceId TEXT PRIMARY KEY REFERENCES devices(id),verifiedAt INTEGER NOT NULL,installer TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relay_commands(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),action TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,createdAt INTEGER NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL);`;
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const relayUpsert = 'INSERT OR REPLACE INTO relay_installations VALUES (?,?,?)';

// Convert positional question marks only, respecting SQL literals, quoted
// identifiers, dollar quotes, and comments. Native $n parameters also work.
// Question-mark JSON operators are outside this compatibility API's grammar.
function parameters(sql) {
  let out = '', index = 0;
  for (let i = 0; i < sql.length;) {
    const tail = sql.slice(i);
    const dollar = tail.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote.');
      out += sql.slice(i, end + dollar.length); i = end + dollar.length;
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]; let end = i + 1;
      for (; end < sql.length; end++) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) end++;
          else break;
        }
      }
      if (end === sql.length) throw new Error('Unterminated SQL quote.');
      out += sql.slice(i, end + 1); i = end + 1;
    } else if (tail.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      if (end < 0) { out += tail; break; }
      out += sql.slice(i, end + 1); i = end + 1;
    } else if (tail.startsWith('/*')) {
      let end = i + 2, depth = 1;
      while (end < sql.length && depth) {
        if (sql.slice(end, end + 2) === '/*') { depth++; end += 2; }
        else if (sql.slice(end, end + 2) === '*/') { depth--; end += 2; }
        else end++;
      }
      if (depth) throw new Error('Unterminated SQL comment.');
      out += sql.slice(i, end); i = end;
    } else {
      out += sql[i] === '?' ? `$${++index}` : sql[i]; i++;
    }
  }
  if (index && /\$\d+/.test(sql)) throw new Error('Do not mix ? and $n placeholders.');
  return out;
}

function rows(result) {
  const integers = new Set(result.fields.filter(field => field.dataTypeID === 20).map(field => field.name));
  return result.rows.map(row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== 'rowid')
    .map(([key, value]) => {
      if (value !== null && integers.has(key)) {
        value = Number(value);
        if (!Number.isSafeInteger(value)) throw new RangeError(`Unsafe PostgreSQL integer in ${key}.`);
      }
      return [names[key] || key, value];
    })));
}

export class PgAdapter {
  constructor(client) {
    if (!client || typeof client.query !== 'function') throw new TypeError('A connected dedicated pg client is required.');
    this.client = client;
    this.context = new AsyncLocalStorage();
    this.pending = Promise.resolve();
  }
  async exclusive(operation) {
    if (this.context.getStore()?.active) return operation();
    const previous = this.pending;
    let release;
    this.pending = new Promise(resolve => { release = resolve; });
    await previous;
    const scope = { active: true };
    try { return await this.context.run(scope, operation); }
    finally { scope.active = false; release(); }
  }
  async transaction(operation) {
    if (this.context.getStore()?.transaction) return operation();
    return this.exclusive(async () => {
      await this.client.query('BEGIN');
      const scope = this.context.getStore();
      scope.transaction = true;
      try {
        // All store instances use this lock before read/modify/write operations.
        await this.client.query('SELECT pg_advisory_xact_lock(1463898192, 1)');
        const result = await operation();
        await this.client.query('COMMIT');
        return result;
      } catch (error) {
        try { await this.client.query('ROLLBACK'); }
        catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      } finally { scope.transaction = false; }
    });
  }
  prepare(sql) {
    if (normalize(sql) === relayUpsert) sql = 'INSERT INTO relay_installations(deviceId,verifiedAt,installer) VALUES (?,?,?) ON CONFLICT(deviceId) DO UPDATE SET verifiedAt=excluded.verifiedAt,installer=excluded.installer';
    const query = parameters(sql);
    const execute = values => this.exclusive(() => this.client.query(query, values));
    return {
      get: async (...values) => rows(await execute(values))[0],
      all: async (...values) => rows(await execute(values)),
      run: async (...values) => ({ changes: (await execute(values)).rowCount }),
    };
  }
  async exec(sql) {
    // create() has already installed the complete, BIGINT-safe relay schema.
    if (normalize(sql) === normalize(relayDDL)) return;
    await this.exclusive(() => this.client.query(sql));
  }
  async close() {
    // Client ownership stays with the caller. Drain work without end/release.
    await this.exclusive(async () => {});
  }
}
