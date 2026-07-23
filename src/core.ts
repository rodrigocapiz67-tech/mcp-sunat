import unzipper from "unzipper";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cacheTtlMs, getCached, setCached } from "./cache.js";

const CKAN_BASE = "https://www.datosabiertos.gob.pe/api/3/action";
const SUNAT_GROUP = "superintendencia-nacional-de-aduanas-y-de-administracion-tributaria-sunat";

export interface CkanResource {
  id: string;
  name: string;
  format: string;
  url: string;
  mimetype?: string | null;
  last_modified?: string | null;
  size?: string | null;
}

export interface CkanPackage {
  name: string;
  title: string;
  notes?: string;
  resources: CkanResource[];
}

// El portal envuelve el resultado de package_show/group_package_show en un array
// adicional de un solo elemento (a diferencia de package_list/resource_show, que
// devuelven la forma estandar de CKAN). Verificado empiricamente contra la API real.
async function ckanRaw<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${CKAN_BASE}/${action}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`CKAN API ${action} devolvio HTTP ${res.status}`);
  }
  const body = (await res.json()) as { success: boolean; result: T; error?: unknown };
  if (!body.success) {
    throw new Error(`CKAN API ${action} fallo: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

async function ckanShowUnwrapped<T>(action: string, params: Record<string, string>): Promise<T> {
  const wrapped = await ckanRaw<[T]>(action, params);
  if (!Array.isArray(wrapped) || wrapped.length !== 1) {
    throw new Error(`Respuesta inesperada de CKAN para la accion ${action}`);
  }
  return wrapped[0];
}

async function ckanShowUnwrappedCached<T>(action: string, params: Record<string, string>): Promise<T> {
  const cacheKey = `${action}:${JSON.stringify(params)}`;
  const ttl = cacheTtlMs();
  const cached = await getCached<T>(cacheKey, ttl);
  if (cached !== null) return cached;

  const data = await ckanShowUnwrapped<T>(action, params);
  await setCached(cacheKey, data);
  return data;
}

export function resourceSummary(r: CkanResource) {
  return {
    id: r.id,
    nombre: r.name,
    formato: r.format,
    tamano: r.size ?? null,
    ultima_modificacion: r.last_modified ?? null,
  };
}

export interface DatasetResumen {
  dataset: string;
  titulo: string;
  cantidad_recursos: number;
}

export async function listarDatasets(): Promise<DatasetResumen[]> {
  const packages = await ckanShowUnwrappedCached<CkanPackage[]>("group_package_show", { id: SUNAT_GROUP });
  return packages.map((p) => ({
    dataset: p.name,
    titulo: p.title,
    cantidad_recursos: p.resources.length,
  }));
}

export interface DatasetDetalle {
  dataset: string;
  titulo: string;
  descripcion: string | null;
  recursos: ReturnType<typeof resourceSummary>[];
}

export async function obtenerDataset(dataset: string): Promise<DatasetDetalle> {
  const pkg = await ckanShowUnwrappedCached<CkanPackage>("package_show", { id: dataset });
  return {
    dataset: pkg.name,
    titulo: pkg.title,
    descripcion: (pkg.notes ?? "").replace(/<[^>]+>/g, "").trim() || null,
    recursos: pkg.resources.map(resourceSummary),
  };
}

export interface RecursoInfo {
  id: string;
  nombre: string;
  url_descarga: string;
  formato_declarado: string;
  mimetype: string | null;
  tamano: string | null;
  ultima_modificacion: string | null;
  es_zip: boolean;
}

function esZipResource(r: CkanResource): boolean {
  return r.url.toLowerCase().endsWith(".zip") || r.mimetype === "application/zip";
}

export async function obtenerRecurso(resourceId: string): Promise<RecursoInfo> {
  const r = await ckanRaw<CkanResource>("resource_show", { id: resourceId });
  return {
    id: r.id,
    nombre: r.name,
    url_descarga: r.url,
    formato_declarado: r.format,
    mimetype: r.mimetype ?? null,
    tamano: r.size ?? null,
    ultima_modificacion: r.last_modified ?? null,
    es_zip: esZipResource(r),
  };
}

function splitCsvHeader(line: string): string[] {
  return line.includes(";") ? line.split(";") : line.split(",");
}

async function leerPrimerasLineas(stream: NodeJS.ReadableStream, maxLineas: number): Promise<string[]> {
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk as Buffer, { stream: true });
    if (text.split("\n").length >= maxLineas) break;
  }
  return text.split("\n").slice(0, maxLineas);
}

export interface PrevisualizacionRecurso {
  recurso: string;
  encabezado: string[];
  filas: string[];
  nota: string;
}

export async function previsualizarRecurso(resourceId: string, filas: number): Promise<PrevisualizacionRecurso> {
  const r = await ckanRaw<CkanResource>("resource_show", { id: resourceId });
  const res = await fetch(r.url);
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar el recurso: HTTP ${res.status}`);
  }

  const esZip = esZipResource(r);
  const neededLines = filas + 1; // +1 por el encabezado

  async function leerZip(): Promise<string[]> {
    const nodeStream = Readable.fromWeb(res!.body as import("node:stream/web").ReadableStream<Uint8Array>);
    const zip = nodeStream.pipe(unzipper.Parse({ forceStream: true }));

    for await (const entry of zip as unknown as AsyncIterable<unzipper.Entry>) {
      if (entry.path.toLowerCase().endsWith(".csv")) {
        const lineas = await leerPrimerasLineas(entry as unknown as NodeJS.ReadableStream, neededLines);
        nodeStream.destroy();
        return lineas;
      }
      entry.autodrain();
    }
    throw new Error("No se encontro ningun archivo .csv dentro del zip.");
  }

  const lineas = esZip
    ? await leerZip()
    : await leerPrimerasLineas(res.body as unknown as NodeJS.ReadableStream, neededLines);

  const [encabezado, ...filasDatos] = lineas;
  return {
    recurso: r.name,
    encabezado: encabezado ? splitCsvHeader(encabezado) : [],
    filas: filasDatos.map((l) => l.trim()).filter((l) => l.length > 0),
    nota: "Previsualizacion parcial: solo se leyeron los primeros bytes/entradas del archivo.",
  };
}

export interface DescargaResultado {
  path: string;
  bytes: number;
  es_zip: boolean;
}

export async function descargarRecurso(
  resourceId: string,
  destino: string,
  onProgress?: (bytes: number, total: number | null) => void
): Promise<DescargaResultado> {
  const r = await ckanRaw<CkanResource>("resource_show", { id: resourceId });
  const res = await fetch(r.url);
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar el recurso: HTTP ${res.status}`);
  }

  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;

  await mkdir(path.dirname(destino), { recursive: true });

  let bytes = 0;
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  nodeStream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    onProgress?.(bytes, total);
  });

  await pipeline(nodeStream, createWriteStream(destino));

  return { path: destino, bytes, es_zip: esZipResource(r) };
}
