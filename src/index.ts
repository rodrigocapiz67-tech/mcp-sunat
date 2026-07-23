#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import {
  listarDatasets,
  obtenerDataset,
  obtenerRecurso,
  previsualizarRecurso,
  descargarRecurso,
} from "./core.js";

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
    const resumen = await listarDatasets();
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
      "'sunat_obtener_recurso', 'sunat_previsualizar_recurso' o 'sunat_descargar_recurso' para acceder al archivo real.",
    inputSchema: {
      dataset: z.string().describe("Slug del dataset, obtenido de sunat_listar_datasets"),
    },
  },
  async ({ dataset }) => {
    const detalle = await obtenerDataset(dataset);
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
    const info = await obtenerRecurso(resource_id);
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

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
    const previsualizacion = await previsualizarRecurso(resource_id, filas);
    return { content: [{ type: "text", text: JSON.stringify(previsualizacion, null, 2) }] };
  }
);

server.registerTool(
  "sunat_descargar_recurso",
  {
    title: "Descargar un recurso completo de SUNAT a disco",
    description:
      "Descarga el archivo completo de un recurso (csv o zip, tal cual lo sirve el portal) al disco local " +
      "y devuelve la ruta y el tamano descargado. A diferencia de 'sunat_previsualizar_recurso', esta tool " +
      "no devuelve el contenido en la respuesta (podria ser enorme), solo confirma donde quedo guardado el archivo. " +
      "Usa el 'id' de un recurso obtenido de 'sunat_obtener_dataset'.",
    inputSchema: {
      resource_id: z.string().describe("Id del recurso a descargar"),
      destino: z
        .string()
        .optional()
        .describe(
          "Ruta de archivo destino. Si se omite, se guarda en la carpeta de descargas configurada " +
            "(SUNAT_DOWNLOAD_DIR o el temp del sistema) usando el id del recurso como nombre."
        ),
    },
  },
  async ({ resource_id, destino }) => {
    const carpetaDefault = process.env.SUNAT_DOWNLOAD_DIR || path.join(os.tmpdir(), "sunat-mcp");
    const rutaDestino = destino || path.join(carpetaDefault, resource_id);
    const resultado = await descargarRecurso(resource_id, rutaDestino);
    return { content: [{ type: "text", text: JSON.stringify(resultado, null, 2) }] };
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
