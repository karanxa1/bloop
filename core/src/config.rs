use worker::Env;

#[derive(Clone)]
pub struct McpServerCfg {
    pub name: String,
    pub url: String,
    pub token: String,
}

#[derive(Clone)]
pub struct Config {
    pub azure_endpoint: String,
    pub azure_key: String,
    pub azure_version: String,
    pub model: String,
    pub model_fallback: String,
    pub servers: Vec<McpServerCfg>,
}

fn env_str(env: &Env, key: &str) -> Option<String> {
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
        let mut servers = Vec::new();
        if let Some(tok) = env_str(env, "GITHUB_TOKEN") {
            servers.push(McpServerCfg {
                name: "github".into(),
                url: "https://api.githubcopilot.com/mcp/".into(),
                token: tok,
            });
        }
        if let (Some(url), Some(tok)) = (
            env_str(env, "COMPOSIO_MCP_URL"),
            env_str(env, "COMPOSIO_API_KEY"),
        ) {
            servers.push(McpServerCfg {
                name: "composio".into(),
                url,
                token: tok,
            });
        }
        // Composio URL without a key (some Connect URLs embed auth)
        if env_str(env, "COMPOSIO_API_KEY").is_none() {
            if let Some(url) = env_str(env, "COMPOSIO_MCP_URL") {
                servers.push(McpServerCfg {
                    name: "composio".into(),
                    url,
                    token: String::new(),
                });
            }
        }
        // Zapier MCP — URL embeds auth, gives real Slack/Gmail/Notion/etc actions
        if let Some(url) = env_str(env, "ZAPIER_MCP_URL") {
            servers.push(McpServerCfg {
                name: "zapier".into(),
                url,
                token: String::new(),
            });
        }
        // Generic extra server: EXTRA_MCP_NAME + EXTRA_MCP_URL (+ optional EXTRA_MCP_TOKEN)
        if let (Some(name), Some(url)) = (
            env_str(env, "EXTRA_MCP_NAME"),
            env_str(env, "EXTRA_MCP_URL"),
        ) {
            servers.push(McpServerCfg {
                name,
                url,
                token: env_str(env, "EXTRA_MCP_TOKEN").unwrap_or_default(),
            });
        }
        // Free public MCP servers — no auth needed
        for (name, url) in [
            ("deepwiki", "https://mcp.deepwiki.com/mcp"),
            ("context7", "https://mcp.context7.com/mcp"),
            ("cf-docs", "https://docs.mcp.cloudflare.com/mcp"),
        ] {
            servers.push(McpServerCfg {
                name: name.into(),
                url: url.into(),
                token: String::new(),
            });
        }
        Config {
            azure_endpoint: env_str(env, "AZURE_OPENAI_ENDPOINT")
                .unwrap_or_else(|| "https://callmissed-resource.cognitiveservices.azure.com".into())
                .trim_end_matches('/')
                .to_string(),
            azure_key: env_str(env, "AZURE_OPENAI_API_KEY").unwrap_or_default(),
            azure_version: env_str(env, "AZURE_OPENAI_API_VERSION")
                .unwrap_or_else(|| "2025-04-01-preview".into()),
            model: env_str(env, "AGENT_MODEL").unwrap_or_else(|| "gpt-6-astra".into()),
            model_fallback: env_str(env, "AGENT_MODEL_FALLBACK")
                .unwrap_or_else(|| "gpt-5.6-terra".into()),
            servers,
        }
    }
}
