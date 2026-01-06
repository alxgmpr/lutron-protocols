//! Unified server - serves React frontend and proxies to Python backend
//!
//! The `cca serve` command provides a single entry point that:
//! 1. Spawns the Python esp32_controller.py backend
//! 2. Serves the built React frontend
//! 3. Proxies /api/* requests to the Python backend

use axum::{
    Router,
    routing::get,
    response::{Html, IntoResponse, Response},
    http::{StatusCode, header, Method, Request},
    body::Body,
    extract::State,
};
use tower_http::cors::{CorsLayer, Any};
use tower_http::services::ServeDir;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

/// Server configuration
#[derive(Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub backend_port: u16,
    pub esp32_host: String,
    pub static_dir: Option<PathBuf>,
    pub controller_path: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 3000,
            backend_port: 8080,
            esp32_host: "10.1.4.59".to_string(),
            static_dir: None,
            controller_path: None,
        }
    }
}

/// Shared server state
struct AppState {
    config: ServerConfig,
    http_client: reqwest::Client,
}

/// Start the unified server
pub async fn start_server(config: ServerConfig) -> Result<(), Box<dyn std::error::Error>> {
    // Find the Python controller
    let controller_path = config.controller_path.clone().unwrap_or_else(|| {
        find_controller_path()
    });

    // Find static files directory
    let static_dir = config.static_dir.clone().unwrap_or_else(|| {
        find_static_dir()
    });

    eprintln!("Starting CCA unified server...");
    eprintln!("  Frontend: http://localhost:{}", config.port);
    eprintln!("  Backend: http://localhost:{}", config.backend_port);
    eprintln!("  ESP32: {}", config.esp32_host);
    eprintln!("  Static: {:?}", static_dir);
    eprintln!();

    // Spawn Python backend
    let mut backend = spawn_backend(&controller_path, config.backend_port)?;
    eprintln!("Python backend started (PID: {:?})", backend.id());

    // Wait for backend to be ready
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Create HTTP client for proxying
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let state = Arc::new(AppState {
        config: config.clone(),
        http_client,
    });

    // Build router
    let app = Router::new()
        .route("/", get(serve_index))
        .route("/index.html", get(serve_index))
        .nest_service("/assets", ServeDir::new(static_dir.join("assets")))
        .route("/api/*path", axum::routing::any(proxy_api))
        .layer(CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::DELETE])
            .allow_headers(Any))
        .with_state(state)
        .fallback(serve_index);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    eprintln!("Listening on http://{}", addr);

    // Handle shutdown gracefully
    let listener = tokio::net::TcpListener::bind(addr).await?;

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    // Kill backend on exit
    eprintln!("\nShutting down...");
    let _ = backend.kill();
    let _ = backend.wait();

    result?;
    Ok(())
}

/// Serve index.html
async fn serve_index() -> impl IntoResponse {
    let static_dir = find_static_dir();
    let index_path = static_dir.join("index.html");

    match tokio::fs::read_to_string(&index_path).await {
        Ok(content) => Html(content).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Html("<h1>Frontend not built</h1><p>Run: cd rf/web && npm run build</p>".to_string())
        ).into_response(),
    }
}

/// Proxy API requests to Python backend
async fn proxy_api(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> impl IntoResponse {
    let path = req.uri().path();
    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    let method = req.method().clone();

    let backend_url = format!(
        "http://localhost:{}{}{}",
        state.config.backend_port,
        path,
        query
    );

    // Build proxy request
    let mut proxy_req = state.http_client.request(method, &backend_url);

    // Forward headers
    for (name, value) in req.headers() {
        if name != header::HOST {
            proxy_req = proxy_req.header(name.clone(), value.clone());
        }
    }

    // Forward body
    let body_bytes = match axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("Body error: {}", e)).into_response();
        }
    };

    if !body_bytes.is_empty() {
        proxy_req = proxy_req.body(body_bytes.to_vec());
    }

    // Send request
    match proxy_req.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

            let mut response = Response::builder().status(status);

            // Forward response headers
            for (name, value) in resp.headers() {
                response = response.header(name.clone(), value.clone());
            }

            // Check for SSE
            let is_sse = resp.headers()
                .get(header::CONTENT_TYPE)
                .map(|v| v.to_str().unwrap_or("").contains("text/event-stream"))
                .unwrap_or(false);

            if is_sse {
                // Stream SSE response
                let stream = resp.bytes_stream();
                response
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .header(header::CACHE_CONTROL, "no-cache")
                    .body(Body::from_stream(stream))
                    .unwrap()
                    .into_response()
            } else {
                // Regular response
                match resp.bytes().await {
                    Ok(body) => response
                        .body(Body::from(body.to_vec()))
                        .unwrap()
                        .into_response(),
                    Err(e) => (StatusCode::BAD_GATEWAY, format!("Response error: {}", e)).into_response(),
                }
            }
        }
        Err(e) => {
            (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", e)).into_response()
        }
    }
}

/// Spawn the Python backend process
fn spawn_backend(controller_path: &str, port: u16) -> std::io::Result<Child> {
    Command::new("python3")
        .args([
            controller_path,
            "serve",
            "--port", &port.to_string(),
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Find the controller script path
fn find_controller_path() -> String {
    let paths = [
        "rf/esp32_controller.py",
        "../rf/esp32_controller.py",
        "../../rf/esp32_controller.py",
        "../esp32_controller.py",
        "~/lutron-tools/rf/esp32_controller.py",
    ];

    for p in paths {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }

    "esp32_controller.py".to_string()
}

/// Find the static files directory
fn find_static_dir() -> PathBuf {
    let paths = [
        "rf/web/dist",
        "../rf/web/dist",
        "../../rf/web/dist",
        "../web/dist",
        "~/lutron-tools/rf/web/dist",
    ];

    for p in paths {
        let path = PathBuf::from(p);
        if path.exists() && path.is_dir() {
            return path;
        }
    }

    PathBuf::from("rf/web/dist")
}

/// Shutdown signal handler
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C handler");
}
