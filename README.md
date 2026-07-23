# sunat-datos-abiertos-mcp

Servidor MCP (Model Context Protocol) que expone los datasets de **SUNAT** publicados en la
[Plataforma Nacional de Datos Abiertos del Perú](https://www.datosabiertos.gob.pe) (padrón RUC con
clasificación de actividad económica CIIU, comprobantes de pago electrónicos, agentes de
retención/percepción de IGV, etc.).

## Requisitos

- Node.js 18+

## Instalación

```bash
npm install
npm run build
```

## Tools disponibles (MCP)

| Tool | Descripción |
|---|---|
| `sunat_listar_datasets` | Lista los datasets de SUNAT disponibles (slug, título, cantidad de recursos). Cacheado localmente. |
| `sunat_obtener_dataset` | Detalle y lista de recursos de un dataset dado su slug. Cacheado localmente. |
| `sunat_obtener_recurso` | Metadata y URL real de descarga de un recurso dado su id. |
| `sunat_previsualizar_recurso` | Previsualiza las primeras filas de un recurso (csv suelto o csv dentro de zip) sin descargarlo completo. |
| `sunat_descargar_recurso` | Descarga el recurso completo (csv o zip) a disco y devuelve la ruta y el tamaño descargado. |

Flujo típico: `sunat_listar_datasets` → `sunat_obtener_dataset` (con el `dataset` elegido) →
`sunat_previsualizar_recurso` o `sunat_descargar_recurso` (con el `id` del recurso elegido).

### Caché local

`sunat_listar_datasets` y `sunat_obtener_dataset` (y sus equivalentes en la CLI, `list`/`show`)
cachean su resultado en disco en `~/.sunat-mcp-cache`, ya que el catálogo de SUNAT cambia con poca
frecuencia. El TTL por defecto es 6 horas y se puede ajustar con la variable de entorno
`SUNAT_CACHE_TTL_MS` (en milisegundos; `0` desactiva la caché). Para limpiarla manualmente:
`sunat cache clear`.

### Nota sobre el portal

La API de este portal es CKAN, pero con dos particularidades verificadas contra la API real:

- `package_search` y `organization_list` están deshabilitados (devuelven 404); por eso este
  servidor navega por el grupo de SUNAT (`group_package_show`) en vez de buscar por palabra clave.
- `package_show` y `group_package_show` envuelven su resultado en un array adicional de un solo
  elemento, a diferencia de `package_list`/`resource_show`. El servidor ya lo maneja.
- El campo `formato` de un recurso no siempre es confiable: varios recursos declarados como `csv`
  son en realidad un `.zip` que contiene el csv adentro. `sunat_previsualizar_recurso` detecta esto
  y descomprime en streaming, cortando la descarga apenas junta las filas pedidas.

## Uso con Claude Desktop / Claude Code

Agrega en tu configuración de servidores MCP (`claude_desktop_config.json` o equivalente):

```json
{
  "mcpServers": {
    "sunat-datos-abiertos": {
      "command": "node",
      "args": ["C:\\source\\mcp-sunat\\build\\index.js"]
    }
  }
}
```

## Uso como CLI en terminal

Además del servidor MCP, este paquete instala un comando `sunat` para usar directamente en la
terminal, sin pasar por un cliente MCP.

```bash
npm run build
npm link        # instala el comando `sunat` globalmente (symlink al build local)
```

Después de eso, `sunat` queda disponible desde cualquier carpeta:

```bash
sunat list                          # lista los datasets de SUNAT
sunat show <dataset>                # detalle y recursos de un dataset
sunat resource <resource_id>        # metadata y URL de un recurso
sunat preview <resource_id> -n 50   # previsualiza filas (default 20)
sunat download <resource_id> -o ./padron.csv   # descarga el recurso completo
sunat cache clear                   # limpia la caché local de datasets
```

Flags globales:

- `--json`: imprime la respuesta como JSON crudo (útil para scripting/pipes) en vez de tablas.
- `--no-color`: desactiva colores en la salida.

Para desinstalar el comando global: `npm unlink -g sunat-datos-abiertos-mcp` (o el nombre que
muestre `npm ls -g --depth=0`).

## Desarrollo

```bash
npm run build   # compila TypeScript a build/
npm start       # corre el servidor MCP compilado (build/index.js)
node build/cli.js list   # corre la CLI sin necesidad de npm link
```
