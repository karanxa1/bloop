use worker::Env;

/// MCP transport selection. `Auto` tries streamable HTTP, then legacy SSE on 404/405.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Transport {
    #[default]
    Auto,
    StreamableHttp,
    Sse,
}

impl Transport {
    pub fn parse(s: &str) -> Transport {
        match s {
            "streamable_http" | "http" | "streamable-http" => Transport::StreamableHttp,
            "sse" => Transport::Sse,
            _ => Transport::Auto,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Transport::Auto => "auto",
            Transport::StreamableHttp => "streamable_http",
            Transport::Sse => "sse",
        }
    }
}

#[derive(Clone, Default)]
pub struct McpServerCfg {
    pub name: String,
    pub url: String,
    pub token: String,
    /// Extra request headers (API-key style auth); sent on every MCP request.
    pub headers: Vec<(String, String)>,
    pub transport: Transport,
}

impl McpServerCfg {
    /// Plain bearer-token server (auto transport, no extra headers).
    pub fn new(name: impl Into<String>, url: impl Into<String>, token: impl Into<String>) -> Self {
        McpServerCfg {
            name: name.into(),
            url: url.into(),
            token: token.into(),
            ..Default::default()
        }
    }
}

#[derive(Clone)]
pub struct Config {
    pub azure_endpoint: String,
    pub azure_key: String,
    pub azure_version: String,
    pub model_fallback: String,
    /// Credential-free public MCP servers, safe for every user.
    pub servers: Vec<McpServerCfg>,
    /// Servers authenticated with operator secrets — admins only (`servers_for`).
    pub operator_servers: Vec<McpServerCfg>,
    /// Lower-cased emails allowed the operator servers (`ADMIN_EMAILS`, comma list).
    pub admin_emails: Vec<String>,
    pub sandbox_url: Option<String>,
    pub sandbox_token: String,
}

/// Public no-auth MCP servers every user gets.
pub const PUBLIC_SERVERS: &[(&str, &str)] = &[
    ("deepwiki", "https://mcp.deepwiki.com/mcp"),
    ("context7", "https://mcp.context7.com/mcp"),
    ("cf-docs", "https://docs.mcp.cloudflare.com/mcp"),
];

/// Parse a comma-separated email list, lower-cased, dropping non-emails.
pub fn parse_admin_emails(s: &str) -> Vec<String> {
    s.split(',')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| e.contains('@'))
        .collect()
}

/// Chat models selectable via `model` in POST /api/chat.
pub const MODELS: &[(&str, &str)] = &[
    ("gpt-5.6-terra", "GPT-5.6 Terra"),
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
];

pub const DEFAULT_MODEL: &str = "gpt-5.6-terra";

pub fn model_allowed(m: &str) -> bool {
    MODELS.iter().any(|(id, _)| *id == m)
}

pub fn env_str(env: &Env, key: &str) -> Option<String> {
    if let Ok(v) = env.var(key) {
        let s = v.to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    if let Ok(s) = env.secret(key) {
        let s = s.to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

impl Config {
    pub fn from_env(env: &Env) -> Self {
        // Operator-credentialed servers: the secrets act as the operator, so
        // they are attached only for admins (see `servers_for`).
        let mut operator_servers = Vec::new();
        if let Some(tok) = env_str(env, "GITHUB_TOKEN") {
            operator_servers.push(McpServerCfg::new("github", "https://api.githubcopilot.com/mcp/", tok));
        }
        if let Some(url) = env_str(env, "COMPOSIO_MCP_URL") {
            // Some Connect URLs embed auth, so the key is optional.
            let key = env_str(env, "COMPOSIO_API_KEY").unwrap_or_default();
            operator_servers.push(McpServerCfg::new("composio", url, key));
        }
        // Zapier MCP — the URL itself is the credential.
        if let Some(url) = env_str(env, "ZAPIER_MCP_URL") {
            operator_servers.push(McpServerCfg::new("zapier", url, ""));
        }
        // Generic extra server: EXTRA_MCP_NAME + EXTRA_MCP_URL (+ optional EXTRA_MCP_TOKEN)
        if let (Some(name), Some(url)) = (env_str(env, "EXTRA_MCP_NAME"), env_str(env, "EXTRA_MCP_URL")) {
            let tok = env_str(env, "EXTRA_MCP_TOKEN").unwrap_or_default();
            operator_servers.push(McpServerCfg::new(name, url, tok));
        }
        let servers = PUBLIC_SERVERS
            .iter()
            .map(|(name, url)| McpServerCfg::new(*name, *url, ""))
            .collect();
        Config {
            operator_servers,
            admin_emails: parse_admin_emails(&env_str(env, "ADMIN_EMAILS").unwrap_or_default()),
            azure_endpoint: env_str(env, "AZURE_OPENAI_ENDPOINT")
                .unwrap_or_else(|| "https://callmissed-resource.cognitiveservices.azure.com".into())
                .trim_end_matches('/')
                .to_string(),
            azure_key: env_str(env, "AZURE_OPENAI_API_KEY").unwrap_or_default(),
            azure_version: env_str(env, "AZURE_OPENAI_API_VERSION")
                .unwrap_or_else(|| "2025-04-01-preview".into()),
            model_fallback: env_str(env, "AGENT_MODEL_FALLBACK")
                .unwrap_or_else(|| "gpt-5.6-sol".into()),
            servers,
            sandbox_url: env_str(env, "SANDBOX_URL").map(|u| u.trim_end_matches('/').to_string()),
            sandbox_token: env_str(env, "SANDBOX_TOKEN").unwrap_or_default(),
        }
    }

    /// MCP servers a caller may use: operator-credentialed ones (admins only), then public ones.
    pub fn servers_for(&self, admin: bool) -> Vec<McpServerCfg> {
        let mut v = if admin { self.operator_servers.clone() } else { Vec::new() };
        v.extend(self.servers.iter().cloned());
        v
    }

    pub fn is_admin_email(&self, email: &str) -> bool {
        let email = email.trim().to_ascii_lowercase();
        !email.is_empty() && self.admin_emails.iter().any(|a| *a == email)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_admin_emails() {
        assert_eq!(
            parse_admin_emails(" Karan@bloop.dev, ,nope, b@x.io "),
            vec!["karan@bloop.dev".to_string(), "b@x.io".to_string()]
        );
        assert!(parse_admin_emails("").is_empty());
    }

    #[test]
    fn operator_servers_only_for_admins() {
        let cfg = Config {
            azure_endpoint: String::new(),
            azure_key: String::new(),
            azure_version: String::new(),
            model_fallback: String::new(),
            servers: vec![McpServerCfg::new("deepwiki", "https://mcp.deepwiki.com/mcp", "")],
            operator_servers: vec![McpServerCfg::new("github", "https://api.githubcopilot.com/mcp/", "tok")],
            admin_emails: parse_admin_emails("karan@bloop.dev"),
            sandbox_url: None,
            sandbox_token: String::new(),
        };
        let names = |admin| cfg.servers_for(admin).into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(names(false), vec!["deepwiki"]);
        assert_eq!(names(true), vec!["github", "deepwiki"]);
        assert!(cfg.is_admin_email("KARAN@bloop.dev"));
        assert!(!cfg.is_admin_email("karan@bloop.dev.evil.com"));
        assert!(!cfg.is_admin_email(""));
    }
}
