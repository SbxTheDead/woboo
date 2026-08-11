# Changelog

All notable changes to Woboo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-12

### Added
- **Mission persistence**: Every mission is saved to disk; survives crashes and can be browsed in the dashboard history tab
- **Cost tracking**: API token usage and cost are tracked per call, with a running total shown in the dashboard header
- **Dashboard tabs**: Mission / History / Settings panels with keyboard shortcuts (Ctrl+1/2/3)
- **Mission history view**: Browse past missions with duration, step count, and status
- **Settings panel**: In-dashboard controls for notifications, brain selection, data cleanup, and export
- **Desktop notifications**: OS-level notifications when a mission completes (with permission)
- **Data cleanup**: Automatic removal of old screenshots (>7 days) and audit log rotation (>2MB)
- **Task templates**: Save, list, and re-run named tasks; built-in examples shown via `woboo templates examples`
- **Mission scheduling**: Schedule missions to run at a specific time or on a recurring interval
- **Health endpoint**: `/api/health` returns uptime, memory, cost, and version
- **Costs endpoint**: `/api/costs` returns usage summary by model
- **Export/Import**: Export all mission history to JSON; purge old missions
- **API retry with backoff**: Brain calls retry up to 3 times with exponential backoff on transient failures
- **Rate limiting**: 100 requests/minute per IP on the dashboard server
- **Content Security Policy**: CSP headers on the dashboard HTML
- **Security hardening**: Owner key removed from URL parameters; security headers added
- **.env support**: API keys can be set via .env file in the working directory
- **Proxy support**: HTTP_PROXY / HTTPS_PROXY environment variables are respected
- **Accessibility**: ARIA labels, roles, keyboard navigation, screen reader support throughout the dashboard
- **Vault module**: Secrets encryption at rest (DPAPI on Windows, derived key on other platforms)
- **New CLI commands**: `history`, `costs`, `cleanup`, `templates`, `schedule`, `export`, `purge`
- **Publishable**: Removed `private: true` from package.json; added keywords and repository URL

### Changed
- Version bumped to 0.2.0
- Electron moved from devDependencies to dependencies (needed at runtime for widget)
- Mission state is persisted at every transition (start, step, done)

## [0.1.0] - 2026-07-01

### Added
- Core mission loop: plan → execute → verify → repair → accept → report
- DOM-based browser driver via Chrome DevTools Protocol (16ms per action)
- Safety architecture: STOP latch, command classification, owner approval
- Research loop: search → judge → read → gap analysis → draft → critique → revise → PDF
- Telegram bot integration: pairing, approvals, file delivery
- Desktop companion: Electron-based always-on-top widget with tray icon
- Self-contained dashboard: no build step, no dependencies, dark theme
- Memory system: per-workspace lessons, corrections, checks, facts
- NVIDIA NIM and Anthropic brain providers
- Journal with append-only rotation
- Audit trail for security decisions
- Separate browser profile for Woboo's sessions
