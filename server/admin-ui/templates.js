export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderNavLink({ active, href, label, path }) {
  return `
    <a class="nav-link ${active ? "active" : ""}" href="${href}" data-nav="${escapeHtml(path)}">
      <span>${escapeHtml(label)}</span>
      <span class="nav-link-mark" aria-hidden="true">${active ? "●" : "·"}</span>
    </a>
  `;
}

export function renderDialog(dialog, formatJson) {
  if (!dialog) {
    return `<div class="dialog-root" hidden></div>`;
  }

  const isJsonPreview = dialog.mode === "json-preview";
  return `
    <div class="dialog-root">
      <form class="dialog-card ${isJsonPreview ? "json-preview-dialog" : ""}" id="confirm-dialog">
        <h3>${escapeHtml(dialog.title)}</h3>
        <p>${escapeHtml(dialog.description)}</p>
        ${
          isJsonPreview
            ? `<pre class="pre">${formatJson(dialog.payload)}</pre>`
            : `
              <div class="field">
                <label for="dialog-reason">操作原因</label>
                <textarea id="dialog-reason" name="reason" placeholder="可选，建议填写便于审计追溯。">${escapeHtml(dialog.defaultReason || "")}</textarea>
              </div>
            `
        }
        <div class="dialog-actions">
          <button type="button" class="button ghost" data-dialog-close>${isJsonPreview ? "关闭" : "取消"}</button>
          ${isJsonPreview ? "" : `<button type="submit" class="button primary">${escapeHtml(dialog.confirmLabel || "确认")}</button>`}
        </div>
      </form>
    </div>
  `;
}

export function renderLoginScreen(notice) {
  return `
    <div class="login-shell">
      <div class="login-layout">
        <form class="login-card" id="login-form">
          <span class="brand-eyebrow">Admin Login</span>
          <h2>登录后台</h2>
          <p>使用服务端配置的管理员账号进入管理控制面板。</p>
          ${notice ? `<div class="notice ${escapeHtml(notice.type)}">${escapeHtml(notice.message)}</div>` : ""}
          <div class="login-fields">
            <div class="field">
              <label for="username">用户名</label>
              <input id="username" name="username" autocomplete="username" required />
            </div>
            <div class="field">
              <label for="password">密码</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required />
            </div>
          </div>
          <div class="actions login-actions">
            <button class="button primary" type="submit">登录</button>
          </div>
        </form>
      </div>
    </div>
  `;
}
