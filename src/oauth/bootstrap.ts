import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

export type OAuthScope = "cortex:read" | "cortex:write" | "mcp";

export interface OAuthBootstrapConfig {
  issuer: string;
  subject: string;
  agentExternalId: string;
  allowedScopes: readonly OAuthScope[];
}

export interface OAuthBootstrapResult {
  principalId: string;
  bindingId: string;
  agentId: number;
  agentExternalId: string;
  created: boolean;
}

interface AgentRow {
  id: number;
  external_id: string;
}

interface PrincipalRow {
  id: string;
  status: string;
}

interface BindingRow {
  id: string;
  agent_id: number;
  status: string;
  is_default: boolean;
  binding_version: number;
  allowed_scopes: string[];
}

const CANONICAL_SCOPE_ORDER: readonly OAuthScope[] = ["cortex:read", "cortex:write", "mcp"];
const SUPPORTED_SCOPES = new Set<OAuthScope>(CANONICAL_SCOPE_ORDER);

function boundedNonEmpty(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function canonicalIssuer(value: string): string {
  const bounded = boundedNonEmpty(value, "issuer", 2048);
  let parsed: URL;
  try {
    parsed = new URL(bounded);
  } catch {
    throw new Error("issuer must be an absolute HTTP(S) URL");
  }
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /[?#]/.test(bounded) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("issuer must be an absolute HTTP(S) URL");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(host);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error("issuer must use HTTPS outside loopback development");
  }
  const canonical = parsed.toString().replace(/\/$/, "");
  if (canonical.length > 2048) {
    throw new Error("issuer must contain between 1 and 2048 characters");
  }
  return canonical;
}

function canonicalScopes(scopes: readonly OAuthScope[]): OAuthScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("At least one OAuth bootstrap scope is required");
  }
  const unique = new Set<OAuthScope>();
  for (const scope of scopes) {
    if (!SUPPORTED_SCOPES.has(scope)) {
      throw new Error(`Unsupported OAuth bootstrap scope: ${String(scope)}`);
    }
    if (unique.has(scope)) {
      throw new Error(`Duplicate OAuth bootstrap scope: ${scope}`);
    }
    unique.add(scope);
  }
  return CANONICAL_SCOPE_ORDER.filter((scope) => unique.has(scope));
}

function normalizedConfig(config: OAuthBootstrapConfig): OAuthBootstrapConfig {
  return {
    issuer: canonicalIssuer(config.issuer),
    subject: boundedNonEmpty(config.subject, "subject", 255),
    agentExternalId: boundedNonEmpty(config.agentExternalId, "agentExternalId", 64),
    allowedScopes: canonicalScopes(config.allowedScopes),
  };
}

function sameScopes(left: readonly string[], right: readonly OAuthScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

async function resolveAgent(sql: Sql | TransactionSql, externalId: string): Promise<AgentRow> {
  const rows = (await sql`
    SELECT id, external_id
    FROM public.agents
    WHERE external_id = ${externalId}
    ORDER BY id ASC
  `) as unknown as AgentRow[];
  if (rows.length !== 1) {
    throw new Error(`OAuth bootstrap agent ${externalId} must resolve to exactly one existing agent`);
  }
  return rows[0];
}

function assertPrincipalAndBinding(
  principal: PrincipalRow | undefined,
  bindings: readonly BindingRow[],
  agent: AgentRow,
  scopes: readonly OAuthScope[]
): { principal: PrincipalRow; binding: BindingRow } {
  if (!principal || principal.status !== "active") {
    throw new Error("OAuth bootstrap principal is missing or disabled");
  }

  const defaults = bindings.filter((binding) => binding.status === "active" && binding.is_default);
  if (defaults.length !== 1) {
    throw new Error("OAuth bootstrap principal must have exactly one active default binding");
  }
  const binding = defaults[0];
  if (binding.agent_id !== agent.id) {
    throw new Error("OAuth bootstrap would replace an existing default agent binding");
  }
  if (!sameScopes(binding.allowed_scopes, scopes)) {
    throw new Error("OAuth bootstrap binding scopes do not match the configured scopes");
  }

  return { principal, binding };
}

export async function bootstrapOAuthAuthority(
  sql: Sql,
  config: OAuthBootstrapConfig
): Promise<OAuthBootstrapResult> {
  const normalized = normalizedConfig(config);

  return await sql.begin(async (transaction) => {
    await transaction`SET LOCAL search_path = pg_catalog, public`;
    const agent = await resolveAgent(transaction, normalized.agentExternalId);
    const principalId = randomUUID();
    const inserted = (await transaction`
      INSERT INTO public.oauth_principals (id, issuer, subject)
      VALUES (${principalId}, ${normalized.issuer}, ${normalized.subject})
      ON CONFLICT (issuer, subject) DO NOTHING
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    const principalRows = (await transaction`
      SELECT id, status
      FROM public.oauth_principals
      WHERE issuer = ${normalized.issuer} AND subject = ${normalized.subject}
      FOR UPDATE
    `) as unknown as PrincipalRow[];
    const principal = principalRows[0];
    if (!principal || principal.status !== "active") {
      throw new Error("OAuth bootstrap principal is missing or disabled");
    }

    let bindings = (await transaction`
      SELECT id, agent_id, status, is_default, binding_version,
             allowed_scopes::text[] AS allowed_scopes
      FROM public.oauth_agent_bindings
      WHERE principal_id = ${principal.id}
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `) as unknown as BindingRow[];

    let binding = bindings.find(
      (candidate) => candidate.status === "active" && candidate.is_default
    );
    let bindingCreated = false;
    if (!binding) {
      const matching = bindings.find((candidate) => candidate.agent_id === agent.id);
      if (matching) {
        if (matching.status !== "active") {
          throw new Error("OAuth bootstrap will not reactivate a revoked agent binding");
        }
        if (!sameScopes(matching.allowed_scopes, normalized.allowedScopes)) {
          throw new Error("OAuth bootstrap binding scopes do not match the configured scopes");
        }
        const updated = (await transaction`
          UPDATE public.oauth_agent_bindings
          SET is_default = TRUE, updated_at = NOW()
          WHERE id = ${matching.id} AND status = 'active' AND is_default = FALSE
          RETURNING id, agent_id, status, is_default, binding_version,
                    allowed_scopes::text[] AS allowed_scopes
        `) as unknown as BindingRow[];
        binding = updated[0];
      } else {
        const bindingId = randomUUID();
        const created = (await transaction`
          INSERT INTO public.oauth_agent_bindings (
            id,
            principal_id,
            agent_id,
            status,
            is_default,
            binding_version,
            allowed_scopes
          )
          VALUES (
            ${bindingId},
            ${principal.id},
            ${agent.id},
            'active',
            TRUE,
            1,
            ${transaction.array([...normalized.allowedScopes])}::public.oauth_scope[]
          )
          RETURNING id, agent_id, status, is_default, binding_version,
                    allowed_scopes::text[] AS allowed_scopes
        `) as unknown as BindingRow[];
        binding = created[0];
        bindingCreated = true;
      }
      bindings = (await transaction`
        SELECT id, agent_id, status, is_default, binding_version,
               allowed_scopes::text[] AS allowed_scopes
        FROM public.oauth_agent_bindings
        WHERE principal_id = ${principal.id}
        ORDER BY created_at ASC, id ASC
      `) as unknown as BindingRow[];
    }

    const verified = assertPrincipalAndBinding(
      principal,
      bindings,
      agent,
      normalized.allowedScopes
    );
    return {
      principalId: verified.principal.id,
      bindingId: verified.binding.id,
      agentId: agent.id,
      agentExternalId: agent.external_id,
      created: inserted.length > 0 || bindingCreated,
    };
  });
}

export async function assertOAuthBootstrap(
  sql: Sql,
  config: OAuthBootstrapConfig
): Promise<OAuthBootstrapResult> {
  const normalized = normalizedConfig(config);
  return await sql.begin(async (transaction) => {
    await transaction`SET LOCAL search_path = pg_catalog, public`;
    const agent = await resolveAgent(transaction, normalized.agentExternalId);
    const principalRows = (await transaction`
      SELECT id, status
      FROM public.oauth_principals
      WHERE issuer = ${normalized.issuer} AND subject = ${normalized.subject}
    `) as unknown as PrincipalRow[];
    if (principalRows.length !== 1) {
      throw new Error("OAuth bootstrap principal must resolve exactly once");
    }
    const bindings = (await transaction`
      SELECT id, agent_id, status, is_default, binding_version,
             allowed_scopes::text[] AS allowed_scopes
      FROM public.oauth_agent_bindings
      WHERE principal_id = ${principalRows[0].id}
      ORDER BY created_at ASC, id ASC
    `) as unknown as BindingRow[];
    const verified = assertPrincipalAndBinding(
      principalRows[0],
      bindings,
      agent,
      normalized.allowedScopes
    );

    return {
      principalId: verified.principal.id,
      bindingId: verified.binding.id,
      agentId: agent.id,
      agentExternalId: agent.external_id,
      created: false,
    };
  });
}
