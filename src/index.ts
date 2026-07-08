#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import unzipper from "unzipper";
import { Readable } from "node:stream";

const CKAN_BASE = "https://www.datosabiertos.gob.pe/api/3/action";
const SUNAT_GROUP = "superintendencia-nacional-de-aduanas-y-de-administracion-tributaria-sunat";

interface CkanResource {
  id: string;
  name: string;
  format: string;
  url: string;
  mimetype?: string | null;
  last_modified?: string | null;
  size?: string | null;
}

interface CkanPackage {
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

function resourceSummary(r: CkanResource) {
  return {
    id: r.id,
    nombre: r.name,
    formato: r.format,
    tamano: r.size ?? null,
    ultima_modificacion: r.last_modified ?? null,
  };
}

const server = new McpServer({
  name: "sunat-datos-abiertos-mcp",
  version: "0.1.0",
});

server.registerTool(
  "sunat_listar_datasets",
  {
    title: "Listar datasets de SUNAT",
    description:
      "Lista los datasets (padrones de contribuyentes, comprobantes electronicos, etc.) publicados por " +
      "SUNAT en la Plataforma Nacional de Datos Abiertos del Peru (datosabiertos.gob.pe). " +
      "Usa el campo 'dataset' de cada resultado con 'sunat_obtener_dataset' para ver sus recursos.",
    inputSchema: {},
  },
  async () => {
    const packages = await ckanShowUnwrapped<CkanPackage[]>("group_package_show", { id: SUNAT_GROUP });
    const resumen = packages.map((p) => ({
      dataset: p.name,
      titulo: p.title,
      cantidad_recursos: p.resources.length,
    }));
    return { content: [{ type: "text", text: JSON.stringify(resumen, null, 2) }] };
  }
);

server.registerTool(
  "sunat_obtener_dataset",
  {
    title: "Obtener detalle de un dataset de SUNAT",
    description:
      "Devuelve la descripcion y la lista de recursos (archivos) de un dataset de SUNAT identificado por " +
      "su slug (campo 'dataset' de 'sunat_listar_datasets'). Cada recurso trae un 'id' que se usa con " +
      "'sunat_obtener_recurso' o 'sunat_previsualizar_recurso' para acceder al archivo real.",
    inputSchema: {
      dataset: z.string().describe("Slug del dataset, obtenido de sunat_listar_datasets"),
    },
  },
  async ({ dataset }) => {
    const pkg = await ckanShowUnwrapped<CkanPackage>("package_show", { id: dataset });
    const detalle = {
      dataset: pkg.name,
      titulo: pkg.title,
      descripcion: (pkg.notes ?? "").replace(/<[^>]+>/g, "").trim() || null,
      recursos: pkg.resources.map(resourceSummary),
    };
    return { content: [{ type: "text", text: JSON.stringify(detalle, null, 2) }] };
  }
);

server.registerTool(
  "sunat_obtener_recurso",
  {
    title: "Obtener metadata y URL de descarga real de un recurso",
    description:
      "Dado el 'id' de un recurso (de 'sunat_obtener_dataset'), devuelve su metadata completa incluyendo " +
      "la URL directa de descarga del archivo. Nota: en este portal el campo 'formato' no siempre es " +
      "confiable; muchos archivos declarados como csv en realidad son .zip que contienen el csv adentro.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso, obtenido de sunat_obtener_dataset"),
    },
  },
  async ({ resource_id }) => {
    const r = await ckanRaw<CkanResource>("resource_show", { id: resource_id });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: r.id,
              nombre: r.name,
              url_descarga: r.url,
              formato_declarado: r.format,
              mimetype: r.mimetype ?? null,
              tamano: r.size ?? null,
              ultima_modificacion: r.last_modified ?? null,
              es_zip: r.url.toLowerCase().endsWith(".zip") || r.mimetype === "application/zip",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

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

server.registerTool(
  "sunat_previsualizar_recurso",
  {
    title: "Previsualizar filas de un recurso de SUNAT",
    description:
      "Descarga solo el inicio de un recurso de SUNAT (csv suelto o csv dentro de un zip) y devuelve el " +
      "encabezado mas las primeras filas, sin bajar el archivo completo (algunos pesan cientos de MB). " +
      "Usa el 'id' de un recurso obtenido de 'sunat_obtener_dataset'.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso a previsualizar"),
      filas: z.number().int().min(1).max(200).default(20).describe("Cantidad de filas de datos a devolver (max 200)"),
    },
  },
  async ({ resource_id, filas }) => {
    const r = await ckanRaw<CkanResource>("resource_show", { id: resource_id });
    const res = await fetch(r.url);
    if (!res.ok || !res.body) {
      throw new Error(`No se pudo descargar el recurso: HTTP ${res.status}`);
    }

    const esZip = r.url.toLowerCase().endsWith(".zip") || r.mimetype === "application/zip";
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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              recurso: r.name,
              encabezado: encabezado ? splitCsvHeader(encabezado) : [],
              filas: filasDatos.map((l) => l.trim()).filter((l) => l.length > 0),
              nota: "Previsualizacion parcial: solo se leyeron los primeros bytes/entradas del archivo.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sunat-datos-abiertos-mcp corriendo por stdio");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
