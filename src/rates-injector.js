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

const EDS_BACKEND = 'eds-content';
const EDS_ORIGIN = 'https://main--kynetic-trust--znikolovski.aem.live';

// Mirrors aem.js toClassName() so placeholder keys resolve identically on both sides.
function toClassName(name) {
  return name.toLowerCase().replace(/[^0-9a-z]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function fetchPlaceholders() {
  const res = await fetch(
    new Request(`${EDS_ORIGIN}/placeholders.json`),
    { backend: EDS_BACKEND },
  );
  if (!res.ok) return {};
  const { data } = await res.json();
  return Object.fromEntries(
    data
      .filter((row) => row.Key && row.Text)
      .map((row) => [toClassName(row.Key), row.Text]),
  );
}

async function ratesInjectorHandler(req) {
  // Rewrite host to EDS origin so the backend receives the correct Host header.
  const url = new URL(req.url);
  const backendReq = new Request(
    `${EDS_ORIGIN}${url.pathname}${url.search}`,
    { method: req.method, headers: req.headers },
  );

  const pageRes = await fetch(backendReq, { backend: EDS_BACKEND });

  const contentType = pageRes.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    return pageRes;
  }

  let map = {};
  try {
    map = await fetchPlaceholders();
  } catch (e) {
    console.warn('Placeholder fetch failed, serving page unmodified:', e.message);
    return pageRes;
  }

  if (Object.keys(map).length === 0) {
    return pageRes;
  }

  const html = await pageRes.text();
  const replaced = html.replace(/\{\{([\w-]+)\}\}/g, (m, key) => map[key] ?? m);

  const headers = new Headers(pageRes.headers);
  headers.delete('content-length');

  return new Response(replaced, {
    status: pageRes.status,
    statusText: pageRes.statusText,
    headers,
  });
}

export { ratesInjectorHandler };
