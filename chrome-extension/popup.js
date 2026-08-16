const $ = (id) => document.getElementById(id);

const MAX_PDF_BYTES = 80 * 1024 * 1024;

const fields = {
  title: $("title"),
  authors: $("authors"),
  doi: $("doi"),
  journal: $("journal"),
  published: $("published"),
  url: $("url"),
  pdf: $("pdf"),
};

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  bindEvents();
  await readCurrentPage();
});

function bindEvents() {
  $("refresh").addEventListener("click", readCurrentPage);
  $("test").addEventListener("click", testReceiver);
  $("savePdf").addEventListener("click", () => savePaper(true));
  $("saveNote").addEventListener("click", () => savePaper(false));
  $("openPdf").addEventListener("click", openPdf);

  $("receiver").addEventListener("change", saveSettings);
  $("token").addEventListener("change", saveSettings);
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get({
    receiver: "http://127.0.0.1:27124",
    token: "",
  });

  $("receiver").value = saved.receiver;
  $("token").value = saved.token;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    receiver: normalizeReceiver($("receiver").value),
    token: $("token").value.trim(),
  });
}

function normalizeReceiver(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function setStatus(message, type = "") {
  const el = $("status");
  el.textContent = message;
  el.classList.remove("error", "success");
  if (type) el.classList.add(type);
}

async function testReceiver() {
  const receiver = normalizeReceiver($("receiver").value);
  if (!receiver) {
    setStatus("Enter the receiver URL.", "error");
    return;
  }

  try {
    const response = await fetch(`${receiver}/health`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) throw new Error(`Receiver returned HTTP ${response.status}.`);

    const data = await response.json();
    if (!data?.ok) throw new Error("Unexpected receiver response.");

    setStatus("Obsidian receiver is running.", "success");
  } catch (error) {
    setStatus(
      "Could not reach Obsidian. Make sure the Paper Receiver plugin is enabled.",
      "error"
    );
  }
}

async function readCurrentPage() {
  setStatus("Reading this page…");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) throw new Error("No active tab found.");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPaperMetadata,
    });

    let metadata = results?.[0]?.result;
    if (!metadata) throw new Error("Could not read metadata from this page.");

    if (metadata.doi) {
      setStatus("Metadata found. Checking Crossref…");
      metadata = await enrichWithCrossref(metadata);
    }

    fillFields(metadata);

    const found = [
      metadata.title && "title",
      metadata.authors?.length && "authors",
      metadata.doi && "DOI",
      metadata.journal && "journal",
      metadata.published && "date",
      metadata.pdf && "PDF",
    ].filter(Boolean);

    setStatus(`Found: ${found.join(", ") || "basic page metadata"}`, "success");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not read this page.", "error");
  }
}

function fillFields(metadata) {
  fields.title.value = metadata.title || "";
  fields.authors.value = (metadata.authors || []).join("\n");
  fields.doi.value = metadata.doi || "";
  fields.journal.value = metadata.journal || "";
  fields.published.value = metadata.published || "";
  fields.url.value = metadata.url || "";
  fields.pdf.value = metadata.pdf || "";
  $("openPdf").disabled = !metadata.pdf;
  $("savePdf").disabled = !metadata.pdf;
}

function getEditedMetadata() {
  return {
    title: fields.title.value.trim(),
    authors: fields.authors.value
      .split(/\n|;/)
      .map((x) => x.trim())
      .filter(Boolean),
    doi: normalizeDoi(fields.doi.value),
    journal: fields.journal.value.trim(),
    published: fields.published.value.trim(),
    url: fields.url.value.trim(),
    pdf: fields.pdf.value.trim(),
  };
}

function normalizeDoi(value) {
  if (!value) return "";
  const match = String(value).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].replace(/[)\],.;]+$/, "") : String(value).trim();
}

async function enrichWithCrossref(metadata) {
  try {
    const doi = normalizeDoi(metadata.doi);
    if (!doi) return metadata;

    const response = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    );

    if (!response.ok) return metadata;

    const payload = await response.json();
    const item = payload?.message;
    if (!item) return metadata;

    const crossrefAuthors = Array.isArray(item.author)
      ? item.author
          .map((a) => [a.given, a.family].filter(Boolean).join(" ").trim())
          .filter(Boolean)
      : [];

    const published = getCrossrefDate(item);

    const pdfLink = Array.isArray(item.link)
      ? item.link.find((link) =>
          String(link["content-type"] || "").toLowerCase().includes("pdf")
        )?.URL || ""
      : "";

    return {
      ...metadata,
      title: metadata.title || first(item.title),
      authors: metadata.authors?.length ? metadata.authors : crossrefAuthors,
      doi: metadata.doi || item.DOI || "",
      journal:
        metadata.journal ||
        first(item["container-title"]) ||
        first(item["short-container-title"]) ||
        "",
      published: metadata.published || published || "",
      pdf: metadata.pdf || pdfLink,
    };
  } catch (error) {
    console.warn("Crossref enrichment failed:", error);
    return metadata;
  }
}

function first(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function getCrossrefDate(item) {
  const sources = [
    item["published-print"],
    item["published-online"],
    item.published,
    item.issued,
    item.created,
  ];

  for (const source of sources) {
    const parts = source?.["date-parts"]?.[0];
    if (parts?.length) {
      return parts.map((n) => String(n).padStart(2, "0")).join("-");
    }

    if (source?.["date-time"]) {
      return String(source["date-time"]).slice(0, 10);
    }
  }

  return "";
}

async function ensurePdfPermission(pdfUrl) {
  const url = new URL(pdfUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("The detected PDF is not a normal HTTP/HTTPS URL.");
  }

  const originPattern = `${url.protocol}//${url.hostname}/*`;

  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern],
  });

  if (hasPermission) return true;

  return chrome.permissions.request({
    origins: [originPattern],
  });
}

async function fetchPdfAsBase64(pdfUrl) {
  const granted = await ensurePdfPermission(pdfUrl);

  if (!granted) {
    throw new Error("PDF site permission was not granted.");
  }

  setStatus("Downloading PDF from the publisher…");

  const response = await fetch(pdfUrl, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`PDF download failed with HTTP ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_PDF_BYTES) {
    throw new Error("PDF is larger than the 80 MB limit in this version.");
  }

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error("PDF is larger than the 80 MB limit in this version.");
  }

  const bytes = new Uint8Array(buffer);

  // Quick signature check. Some publisher "PDF" links return an HTML login page.
  const signature = String.fromCharCode(...bytes.slice(0, 5));
  if (signature !== "%PDF-") {
    const type = response.headers.get("content-type") || "unknown content type";
    throw new Error(
      `The PDF link returned ${type}, not a PDF. It may require publisher authentication.`
    );
  }

  return {
    base64: uint8ToBase64(bytes),
    contentType: response.headers.get("content-type") || "application/pdf",
    finalUrl: response.url || pdfUrl,
  };
}

function uint8ToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }

  return btoa(binary);
}

async function savePaper(includePdf) {
  await saveSettings();

  const receiver = normalizeReceiver($("receiver").value);
  const token = $("token").value.trim();
  const metadata = getEditedMetadata();

  if (!receiver) {
    setStatus("Enter the Obsidian receiver URL.", "error");
    return;
  }

  if (!token) {
    setStatus("Paste the receiver token from Obsidian plugin settings.", "error");
    return;
  }

  if (!metadata.title) {
    setStatus("A paper title is required.", "error");
    return;
  }

  try {
    const payload = {
      metadata,
      pdfBase64: "",
      pdfContentType: "",
    };

    if (includePdf) {
      if (!metadata.pdf) throw new Error("No PDF URL was detected.");

      const pdf = await fetchPdfAsBase64(metadata.pdf);
      payload.pdfBase64 = pdf.base64;
      payload.pdfContentType = pdf.contentType;
      payload.metadata.pdf = pdf.finalUrl;
    }

    setStatus(includePdf ? "Sending note and PDF to Obsidian…" : "Sending note to Obsidian…");

    const response = await fetch(`${receiver}/save-paper`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result?.error || `Receiver returned HTTP ${response.status}.`);
    }

    const message = result.pdfPath
      ? `Saved: ${result.notePath} + ${result.pdfPath}`
      : `Saved: ${result.notePath}`;

    setStatus(message, "success");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not save the paper.", "error");
  }
}

function openPdf() {
  const pdf = fields.pdf.value.trim();
  if (!pdf) return;
  chrome.tabs.create({ url: pdf });
}


// ------------------------------------------------------------
// Runs inside the active page.
// ------------------------------------------------------------

function extractPaperMetadata() {
  function metaValues(...names) {
    const wanted = names.map((x) => x.toLowerCase());

    return [...document.querySelectorAll("meta")]
      .filter((el) => {
        const name = (el.getAttribute("name") || "").toLowerCase();
        const prop = (el.getAttribute("property") || "").toLowerCase();
        return wanted.includes(name) || wanted.includes(prop);
      })
      .map((el) => (el.getAttribute("content") || "").trim())
      .filter(Boolean);
  }

  function firstMeta(...names) {
    return metaValues(...names)[0] || "";
  }

  function normalizeDoi(value) {
    if (!value) return "";

    const match = String(value).match(
      /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i
    );

    return match ? match[0].replace(/[)\],.;]+$/, "") : "";
  }

  function absoluteUrl(value) {
    if (!value) return "";
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  }

  function flattenJsonLd(value, output = []) {
    if (!value) return output;

    if (Array.isArray(value)) {
      value.forEach((item) => flattenJsonLd(item, output));
      return output;
    }

    if (typeof value === "object") {
      output.push(value);

      if (value["@graph"]) flattenJsonLd(value["@graph"], output);
      if (value.mainEntity) flattenJsonLd(value.mainEntity, output);
      if (value.itemListElement) flattenJsonLd(value.itemListElement, output);
    }

    return output;
  }

  function parseJsonLd() {
    const nodes = [];

    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        const parsed = JSON.parse(script.textContent);
        flattenJsonLd(parsed, nodes);
      } catch {
        // Ignore malformed JSON-LD.
      }
    }

    const preferredTypes = [
      "ScholarlyArticle",
      "Article",
      "MedicalScholarlyArticle",
      "TechArticle",
      "Report",
    ];

    return (
      nodes.find((node) => {
        const types = Array.isArray(node["@type"])
          ? node["@type"]
          : [node["@type"]];
        return types.some((type) => preferredTypes.includes(type));
      }) || {}
    );
  }

  function schemaAuthors(article) {
    const value = article.author;
    const list = Array.isArray(value) ? value : value ? [value] : [];

    return list
      .map((author) => {
        if (typeof author === "string") return author.trim();

        return (
          author?.name ||
          [author?.givenName, author?.familyName]
            .filter(Boolean)
            .join(" ")
            .trim()
        );
      })
      .filter(Boolean);
  }

  function schemaDoi(article) {
    const candidates = [];

    if (article.doi) candidates.push(article.doi);

    if (article.identifier) {
      const identifiers = Array.isArray(article.identifier)
        ? article.identifier
        : [article.identifier];

      for (const item of identifiers) {
        if (typeof item === "string") candidates.push(item);
        else if (item) candidates.push(item.value, item.name, item["@id"]);
      }
    }

    candidates.push(article["@id"], article.url, article.sameAs);

    for (const candidate of candidates.flat().filter(Boolean)) {
      const doi = normalizeDoi(candidate);
      if (doi) return doi;
    }

    return "";
  }

  function schemaJournal(article) {
    const parent = article.isPartOf;

    if (typeof parent === "string") return parent;

    if (Array.isArray(parent)) {
      return (
        parent.find((x) => x?.name)?.name ||
        parent.find((x) => x?.headline)?.headline ||
        ""
      );
    }

    return parent?.name || parent?.headline || "";
  }

  const schema = parseJsonLd();

  const title =
    firstMeta(
      "citation_title",
      "dc.title",
      "dcterms.title",
      "prism.title",
      "og:title"
    ) ||
    schema.headline ||
    schema.name ||
    document.title ||
    "";

  let authors = metaValues(
    "citation_author",
    "dc.creator",
    "dcterms.creator"
  );

  if (!authors.length) authors = schemaAuthors(schema);

  if (!authors.length) {
    const byline = firstMeta("author");
    if (byline) authors = [byline];
  }

  const doi =
    normalizeDoi(
      firstMeta(
        "citation_doi",
        "dc.identifier",
        "dcterms.identifier",
        "prism.doi"
      )
    ) ||
    schemaDoi(schema) ||
    normalizeDoi(location.href) ||
    normalizeDoi(document.body?.innerText?.slice(0, 120000) || "");

  const journal =
    firstMeta(
      "citation_journal_title",
      "prism.publicationname",
      "dc.source",
      "dcterms.source"
    ) ||
    schemaJournal(schema) ||
    "";

  const published =
    firstMeta(
      "citation_publication_date",
      "citation_date",
      "prism.publicationdate",
      "dc.date",
      "dcterms.date"
    ) ||
    schema.datePublished ||
    "";

  let pdf = firstMeta(
    "citation_pdf_url",
    "eprints.document_url",
    "wkhealth_pdf_url"
  );

  if (!pdf) {
    const link = document.querySelector(
      'link[type="application/pdf"][href]'
    );
    if (link) pdf = link.getAttribute("href") || "";
  }

  if (!pdf) {
    const anchors = [...document.querySelectorAll("a[href]")];

    const candidate =
      anchors.find((a) =>
        /\.pdf(?:$|[?#])/i.test(a.getAttribute("href") || "")
      ) ||
      anchors.find((a) =>
        /(?:download|view)\s+(?:the\s+)?pdf|pdf\s+(?:download|full text)/i.test(
          (a.textContent || "").trim()
        )
      );

    if (candidate) pdf = candidate.getAttribute("href") || "";
  }

  return {
    title: String(title).trim(),
    authors: [...new Set(authors.map((x) => String(x).trim()).filter(Boolean))],
    doi: String(doi).trim(),
    journal: String(journal).trim(),
    published: String(published).trim(),
    url: location.href,
    pdf: absoluteUrl(pdf),
  };
}
