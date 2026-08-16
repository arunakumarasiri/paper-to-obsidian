const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  normalizePath,
} = require("obsidian");

const http = require("http");
const crypto = require("crypto");

const MAX_BODY_BYTES = 120 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  port: 27124,
  token: "",
  noteFolder: "Papers",
  pdfFolder: "Attachments/Papers",
  openNoteAfterSave: true,
};

module.exports = class PaperReceiverPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    if (!this.settings.token) {
      this.settings.token = crypto.randomBytes(24).toString("hex");
      await this.saveSettings();
    }

    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("Paper receiver: starting…");

    this.addSettingTab(new PaperReceiverSettingTab(this.app, this));

    this.addCommand({
      id: "restart-paper-receiver",
      name: "Restart local paper receiver",
      callback: async () => {
        await this.restartServer();
      },
    });

    this.addCommand({
      id: "copy-paper-receiver-token",
      name: "Copy paper receiver token",
      callback: async () => {
        await navigator.clipboard.writeText(this.settings.token);
        new Notice("Paper receiver token copied.");
      },
    });

    await this.startServer();
  }

  onunload() {
    this.stopServer();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async restartServer() {
    this.stopServer();
    await this.startServer();
  }

  stopServer() {
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {}
      this.server = null;
    }
  }

  async startServer() {
    const port = Number(this.settings.port) || DEFAULT_SETTINGS.port;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error("Paper receiver request error:", error);

        if (!res.headersSent) {
          this.sendJson(res, 500, {
            ok: false,
            error: error?.message || "Unexpected receiver error.",
          });
        } else {
          try {
            res.end();
          } catch (_) {}
        }
      });
    });

    this.server.on("error", (error) => {
      console.error("Paper receiver server error:", error);

      if (this.statusBar) {
        this.statusBar.setText("Paper receiver: stopped");
      }

      new Notice(
        `Paper receiver could not start on port ${port}: ${error.message}`
      );
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };

      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, "127.0.0.1");
    }).catch((error) => {
      console.error(error);
      return null;
    });

    if (this.server?.listening) {
      const endpoint = `http://127.0.0.1:${port}`;

      if (this.statusBar) {
        this.statusBar.setText(`Paper receiver: ${port}`);
        this.statusBar.setAttr("title", endpoint);
      }

      new Notice(`Paper receiver running on ${endpoint}`);
    }
  }

  async handleRequest(req, res) {
    this.setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(
      req.url || "/",
      "http://127.0.0.1"
    );

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      this.sendJson(res, 200, {
        ok: true,
        service: "paper-receiver",
        version: "0.2.0",
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/save-paper") {
      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, {
          ok: false,
          error: "Invalid receiver token.",
        });
        return;
      }

      const payload = await this.readJsonBody(req);
      const result = await this.savePaper(payload);

      this.sendJson(res, 200, {
        ok: true,
        ...result,
      });
      return;
    }

    this.sendJson(res, 404, {
      ok: false,
      error: "Not found.",
    });
  }

  setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
  }

  isAuthorized(req) {
    const auth = String(req.headers.authorization || "");
    return auth === `Bearer ${this.settings.token}`;
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let finished = false;

      const fail = (error) => {
        if (finished) return;
        finished = true;
        reject(error);
      };

      req.on("data", (chunk) => {
        total += chunk.length;

        if (total > MAX_BODY_BYTES) {
          fail(
            new Error(
              "Incoming paper is too large for this receiver (120 MB request limit)."
            )
          );
          req.destroy();
          return;
        }

        chunks.push(chunk);
      });

      req.on("end", () => {
        if (finished) return;
        finished = true;

        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(raw ? JSON.parse(raw) : {});
        } catch (_) {
          reject(new Error("Receiver got invalid JSON."));
        }
      });

      req.on("error", fail);
    });
  }

  sendJson(res, statusCode, value) {
    const body = JSON.stringify(value);

    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });

    res.end(body);
  }

  async savePaper(payload) {
    const metadata = payload?.metadata || {};

    if (!metadata.title || !String(metadata.title).trim()) {
      throw new Error("Paper title is missing.");
    }

    await this.ensureFolder(this.settings.noteFolder);
    await this.ensureFolder(this.settings.pdfFolder);

    const baseStem = this.safeFileName(metadata.title);
    const stem = this.findAvailableStem(baseStem);

    const notePath = normalizePath(
      `${this.settings.noteFolder}/${stem}.md`
    );

    let pdfPath = "";

    if (payload.pdfBase64) {
      pdfPath = normalizePath(
        `${this.settings.pdfFolder}/${stem}.pdf`
      );

      const pdfBuffer = Buffer.from(
        String(payload.pdfBase64),
        "base64"
      );

      if (
        pdfBuffer.length < 5 ||
        pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-"
      ) {
        throw new Error("The received attachment is not a valid PDF.");
      }

      const arrayBuffer = pdfBuffer.buffer.slice(
        pdfBuffer.byteOffset,
        pdfBuffer.byteOffset + pdfBuffer.byteLength
      );

      await this.app.vault.createBinary(
        pdfPath,
        arrayBuffer
      );
    }

    const markdown = this.buildMarkdown(
      metadata,
      pdfPath
    );

    const noteFile = await this.app.vault.create(
      notePath,
      markdown
    );

    if (this.settings.openNoteAfterSave) {
      await this.app.workspace.getLeaf(true).openFile(noteFile);
    }

    new Notice(
      pdfPath
        ? `Saved paper and PDF: ${stem}`
        : `Saved paper note: ${stem}`
    );

    return {
      notePath,
      pdfPath,
    };
  }

  async ensureFolder(folderPath) {
    const normalized = normalizePath(folderPath || "");

    if (!normalized || normalized === "/") {
      return;
    }

    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current
        ? normalizePath(`${current}/${part}`)
        : normalizePath(part);

      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  findAvailableStem(baseStem) {
    let stem = baseStem;
    let counter = 2;

    while (true) {
      const notePath = normalizePath(
        `${this.settings.noteFolder}/${stem}.md`
      );

      const pdfPath = normalizePath(
        `${this.settings.pdfFolder}/${stem}.pdf`
      );

      const noteExists =
        !!this.app.vault.getAbstractFileByPath(notePath);

      const pdfExists =
        !!this.app.vault.getAbstractFileByPath(pdfPath);

      if (!noteExists && !pdfExists) {
        return stem;
      }

      stem = `${baseStem} (${counter})`;
      counter += 1;
    }
  }

  safeFileName(value) {
    const cleaned = String(value || "Untitled paper")
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();

    return (cleaned || "Untitled paper").slice(0, 180);
  }

  yamlString(value) {
    return JSON.stringify(String(value || ""));
  }

  buildMarkdown(metadata, pdfPath) {
    const authors = Array.isArray(metadata.authors)
      ? metadata.authors.filter(Boolean)
      : [];

    const authorYaml = authors.length
      ? authors
          .map((author) => `  - ${this.yamlString(author)}`)
          .join("\n")
      : "  []";

    const pdfWiki = pdfPath
      ? `[[${pdfPath}]]`
      : "";

    return `---
title: ${this.yamlString(metadata.title)}
authors:
${authorYaml}
doi: ${this.yamlString(metadata.doi)}
journal: ${this.yamlString(metadata.journal)}
published: ${this.yamlString(metadata.published)}
url: ${this.yamlString(metadata.url)}
pdf: ${this.yamlString(pdfWiki)}
---

# ${metadata.title}

## Notes

`;
  }
};

class PaperReceiverSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", {
      text: "Paper to Obsidian Receiver",
    });

    containerEl.createEl("p", {
      text:
        "The receiver listens only on 127.0.0.1, so it is accessible only from this computer. " +
        "The browser extension must also provide the secret token below.",
    });

    new Setting(containerEl)
      .setName("Receiver address")
      .setDesc(
        `http://127.0.0.1:${this.plugin.settings.port}`
      )
      .addButton((button) =>
        button
          .setButtonText("Restart receiver")
          .onClick(async () => {
            await this.plugin.restartServer();
          })
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc(
        "Default: 27124. Restart the receiver after changing this."
      )
      .addText((text) =>
        text
          .setPlaceholder("27124")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = Number(value);
            if (
              Number.isInteger(port) &&
              port >= 1024 &&
              port <= 65535
            ) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Receiver token")
      .setDesc(
        "Paste this token into the browser extension. Treat it like a local password."
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.token)
          .setDisabled(true);

        text.inputEl.type = "password";
      })
      .addButton((button) =>
        button
          .setButtonText("Copy token")
          .onClick(async () => {
            await navigator.clipboard.writeText(
              this.plugin.settings.token
            );
            new Notice("Receiver token copied.");
          })
      )
      .addButton((button) =>
        button
          .setButtonText("Generate new token")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.token =
              crypto.randomBytes(24).toString("hex");

            await this.plugin.saveSettings();
            new Notice(
              "New token generated. Update the browser extension."
            );
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Paper note folder")
      .setDesc("Where Markdown paper notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("Papers")
          .setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder =
              value.trim() || "Papers";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("PDF folder")
      .setDesc("Where downloaded paper PDFs are stored.")
      .addText((text) =>
        text
          .setPlaceholder("Attachments/Papers")
          .setValue(this.plugin.settings.pdfFolder)
          .onChange(async (value) => {
            this.plugin.settings.pdfFolder =
              value.trim() || "Attachments/Papers";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open note after saving")
      .setDesc(
        "Open the newly created paper note after the browser extension sends it."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openNoteAfterSave)
          .onChange(async (value) => {
            this.plugin.settings.openNoteAfterSave = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
