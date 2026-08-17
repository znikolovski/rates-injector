/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/// <reference types="@fastly/js-compute" />

import { Backend } from 'fastly:backend';

const EDS_HOST = 'main--kynetic-trust--znikolovski.aem.live';
const EDS_ORIGIN = `https://${EDS_HOST}`;

const AEM_GQL_HOST = 'publish-p115476-e1135027.adobeaemcloud.com';
const AEM_GQL_ENDPOINT = `https://${AEM_GQL_HOST}/content/_cq_graphql/securbank/endpoint.json`;
const AEM_GQL_PERSISTED = `https://${AEM_GQL_HOST}/graphql/execute.json/securbank`;

function toClassName(name) {
  return name.toLowerCase().replace(/[^0-9a-z]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ── Placeholder resolution ────────────────────────────────────────────────────

async function fetchPlaceholders(backend) {
  // Accept-Encoding: identity forces aem.live to return plain text so JSON parsing works
  const res = await fetch(`${EDS_ORIGIN}/placeholders.json`, {
    backend,
    headers: { 'accept-encoding': 'identity' },
  });
  if (!res.ok) return {};
  const { data } = await res.json();
  return Object.fromEntries(
    data.filter((row) => row.Key && row.Value)
      .map((row) => [toClassName(row.Key), row.Value]),
  );
}

// ── AEM GraphQL helpers ───────────────────────────────────────────────────────

async function gqlPost(query, aemBackend) {
  try {
    const res = await fetch(AEM_GQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify({ query }),
      backend: aemBackend,
    });
    if (!res.ok) {
      console.error(`gqlPost HTTP ${res.status} from ${AEM_GQL_ENDPOINT}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error(`gqlPost fetch failed: ${e?.name} — ${e?.message}`);
    return null;
  }
}

async function fetchCardList(aemBackend) {
  const json = await gqlPost(`{
    creditCardList {
      items {
        _path
        name
        monthlyFee
        additionalCardHolderFee
        internationalTransactionFee
        keyBenefits { html }
      }
    }
  }`, aemBackend);
  return json?.data?.creditCardList?.items ?? [];
}

async function fetchCardDetail(slug, aemBackend) {
  try {
    // AEM persisted query format uses semicolon-delimited params with literal path values.
    const path = `/content/dam/securbank/en/cards/${slug}`;
    const url = `${AEM_GQL_PERSISTED}/CreditCardDetailsByPath;path=${path}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'accept-encoding': 'identity' },
      backend: aemBackend,
    });
    if (!res.ok) {
      console.error(`fetchCardDetail HTTP ${res.status} for ${slug}`);
      return null;
    }
    const json = await res.json();
    return json?.data?.creditCardByPath?.item ?? null;
  } catch (e) {
    console.error(`fetchCardDetail fetch failed: ${e?.name} — ${e?.message}`);
    return null;
  }
}

// ── JSON-LD builders ──────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Escapes <, >, & so a CMS string containing "</script>" can't break the tag.
function safeJsonStringify(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

const PROVIDER = {
  '@type': 'BankOrCreditUnion',
  name: 'SecurBank',
  url: 'https://www.securbank.run.place',
};

function cardToSchema(card, cardUrl) {
  const schema = {
    '@type': 'CreditCard',
    name: card.name,
    url: cardUrl,
    provider: PROVIDER,
    feesAndCommissionsSpecification: [
      `Monthly fee: ${card.monthlyFee}`,
      `Additional cardholder fee: ${card.additionalCardHolderFee}`,
      `International transaction fee: ${card.internationalTransactionFee}`,
    ].join('. '),
  };
  if (card.cardImage?._publishUrl) schema.image = card.cardImage._publishUrl;
  const benefits = stripHtml(card.keyBenefits?.html);
  if (benefits) schema.description = benefits;
  return schema;
}

async function buildListSchema(origin, aemBackend) {
  const cards = await fetchCardList(aemBackend);
  if (!cards.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'SecurBank Credit Cards',
    description: 'Compare all SecurBank credit cards — fees, benefits, and eligibility at a glance.',
    url: `${origin}/credit-cards`,
    itemListElement: cards.map((card, i) => {
      const slug = card._path.split('/').pop();
      return {
        '@type': 'ListItem',
        position: i + 1,
        item: cardToSchema(card, `${origin}/cards/${slug}`),
      };
    }),
  };
}

async function buildDetailSchema(slug, pageUrl, aemBackend) {
  const card = await fetchCardDetail(slug, aemBackend);
  if (!card) return null;
  return {
    '@context': 'https://schema.org',
    ...cardToSchema(card, pageUrl),
  };
}

function injectJsonLd(html, schema) {
  const tag = `<script type="application/ld+json">${safeJsonStringify(schema)}</script>`;
  const idx = html.indexOf('</head>');
  if (idx === -1) return html + tag;
  return html.slice(0, idx) + tag + html.slice(idx);
}

// ── Edge handler ──────────────────────────────────────────────────────────────

async function ratesInjectorHandler(req) {
  // Backends must be created during request handling, not at module init level.
  const edsBackend = new Backend({
    name: 'eds-content',
    target: EDS_HOST,
    useSSL: true,
    tlsMinVersion: 1.2,
  });
  const aemBackend = new Backend({
    name: 'aem-graphql',
    target: AEM_GQL_HOST,
    useSSL: true,
    tlsMinVersion: 1.2,
  });

  const url = new URL(req.url);
  const referer = req.headers.get('referer') ?? '';
  const fetchDest = req.headers.get('sec-fetch-dest') ?? '';

  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'upgrade', 'proxy-connection', 'te', 'trailer',
  ]);
  const upstreamHeaders = new Headers();
  for (const [key, value] of req.headers) {
    if (!skipHeaders.has(key.toLowerCase())) upstreamHeaders.set(key, value);
  }
  // Force uncompressed response so .text() doesn't receive raw gzip bytes
  upstreamHeaders.set('accept-encoding', 'identity');

  const pageRes = await fetch(
    `${EDS_ORIGIN}${url.pathname}${url.search}`,
    { method: req.method, headers: upstreamHeaders, backend: edsBackend },
  );

  const contentType = pageRes.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return pageRes;

  const isDaAuthoringIframe = referer.includes('da.live') && fetchDest === 'iframe';
  if (isDaAuthoringIframe || url.searchParams.has('dapreview')) return pageRes;

  // Decide which JSON-LD schema to build for this path (null = none).
  let schemaPromise = null;
  if (url.pathname === '/credit-cards') {
    schemaPromise = buildListSchema(url.origin, aemBackend);
  } else if (url.pathname.startsWith('/cards/')) {
    const slug = url.pathname.split('/').filter(Boolean).pop();
    if (slug) schemaPromise = buildDetailSchema(slug, req.url, aemBackend);
  }

  // Fetch placeholders, read page HTML, and fetch JSON-LD data in parallel.
  let map = {};
  let html;
  let schema = null;

  try {
    [map, html, schema] = await Promise.all([
      fetchPlaceholders(edsBackend).catch((e) => {
        console.warn('Placeholder fetch failed:', e.message);
        return {};
      }),
      pageRes.text(),
      schemaPromise ?? Promise.resolve(null),
    ]);
  } catch (e) {
    console.warn('Failed to read body:', e.message);
    return new Response('', { status: pageRes.status });
  }

  // Placeholder token replacement.
  let body = Object.keys(map).length
    ? html.replace(/\{\{([\w-]+)\}\}/g, (m, key) => map[key] ?? m)
    : html;

  // JSON-LD injection.
  if (schema) {
    body = injectJsonLd(body, schema);
  }

  // Build response headers from scratch — never forward Content-Encoding or Vary
  // from the upstream response; the CDN handles compression for the client.
  const headers = new Headers();
  for (const name of [
    'content-type', 'cache-control', 'last-modified', 'x-robots-tag', 'strict-transport-security',
  ]) {
    const val = pageRes.headers.get(name);
    if (val) headers.set(name, val);
  }

  return new Response(body, { status: pageRes.status, headers });
}

export { ratesInjectorHandler };
