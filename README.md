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

## Tools disponibles

| Tool | Descripción |
|---|---|
| `sunat_listar_datasets` | Lista los datasets de SUNAT disponibles (slug, título, cantidad de recursos). |
| `sunat_obtener_dataset` | Detalle y lista de recursos de un dataset dado su slug. |
| `sunat_obtener_recurso` | Metadata y URL real de descarga de un recurso dado su id. |
| `sunat_previsualizar_recurso` | Previsualiza las primeras filas de un recurso (csv suelto o csv dentro de zip) sin descargarlo completo. |

Flujo típico: `sunat_listar_datasets` → `sunat_obtener_dataset` (con el `dataset` elegido) →
`sunat_previsualizar_recurso` (con el `id` del recurso elegido).

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
      "args": ["C:\\source\\mcp-'nodefinido'\\build\\index.js"]
    }
  }
}
```

## Desarrollo

```bash
npm run build   # compila TypeScript a build/
npm start       # corre el servidor compilado
```
