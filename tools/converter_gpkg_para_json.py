import sqlite3
import json
import os
import argparse

# Mapeamento oficial dos códigos IBGE de UF para siglas
UF_SIGLAS = {
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL',
    '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR',
    '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF'
}

def extrair_dados_gpkg(caminho_gpkg):
    if not os.path.exists(caminho_gpkg):
        raise FileNotFoundError(f"Arquivo não encontrado: {caminho_gpkg}")

    print(f"Conectando ao banco GeoPackage: {caminho_gpkg}...")
    conn = sqlite3.connect(caminho_gpkg)
    cursor = conn.cursor()

    print("Consultando registros de bairros...")
    cursor.execute('''
        SELECT DISTINCT
            CD_REGIAO, NM_REGIAO,
            CD_UF, NM_UF,
            CD_MUN, NM_MUN,
            CD_RGINT, NM_RGINT,
            CD_RGI, NM_RGI,
            CD_CONCURB, NM_CONCURB,
            CD_DIST, NM_DIST,
            CD_SUBDIST, NM_SUBDIST,
            CD_BAIRRO, NM_BAIRRO
        FROM BR_bairros_CD2022
        ORDER BY CD_UF, NM_MUN, NM_BAIRRO
    ''')
    rows = cursor.fetchall()
    conn.close()
    print(f"Total de bairros únicos encontrados: {len(rows)}")
    return rows

def gerar_hierarquico(rows):
    hierarquia = {}
    for row in rows:
        (cd_regiao, nm_regiao, cd_uf, nm_uf, cd_mun, nm_mun, 
         cd_rgint, nm_rgint, cd_rgi, nm_rgi, cd_concurb, nm_concurb,
         cd_dist, nm_dist, cd_subdist, nm_subdist, cd_bairro, nm_bairro) = row
        
        if cd_uf not in hierarquia:
            hierarquia[cd_uf] = {
                'codigo_uf': cd_uf,
                'sigla_uf': UF_SIGLAS.get(cd_uf, ''),
                'nome_uf': nm_uf,
                'regiao': nm_regiao,
                'municipios': {}
            }
            
        municipios = hierarquia[cd_uf]['municipios']
        if cd_mun not in municipios:
            municipios[cd_mun] = {
                'codigo_ibge': cd_mun,
                'nome_municipio': nm_mun,
                'regiao_intermediaria': nm_rgint,
                'regiao_imediata': nm_rgi,
                'concentracao_urbana': nm_concurb,
                'bairros': []
            }
            
        municipios[cd_mun]['bairros'].append({
            'codigo_bairro': cd_bairro,
            'nome_bairro': nm_bairro,
            'codigo_distrito': cd_dist,
            'nome_distrito': nm_dist,
            'codigo_subdistrito': cd_subdist,
            'nome_subdistrito': nm_subdist
        })

    resultado = []
    for cd_uf in sorted(hierarquia.keys(), key=lambda x: int(x)):
        dados_uf = hierarquia[cd_uf]
        lista_muns = list(dados_uf['municipios'].values())
        dados_uf['total_municipios'] = len(lista_muns)
        dados_uf['total_bairros'] = sum(len(m['bairros']) for m in lista_muns)
        dados_uf['municipios'] = lista_muns
        resultado.append(dados_uf)
    return resultado

def gerar_plano(rows):
    resultado = []
    for row in rows:
        (cd_regiao, nm_regiao, cd_uf, nm_uf, cd_mun, nm_mun, 
         cd_rgint, nm_rgint, cd_rgi, nm_rgi, cd_concurb, nm_concurb,
         cd_dist, nm_dist, cd_subdist, nm_subdist, cd_bairro, nm_bairro) = row
        
        resultado.append({
            'codigo_uf': cd_uf,
            'sigla_uf': UF_SIGLAS.get(cd_uf, ''),
            'nome_uf': nm_uf,
            'regiao': nm_regiao,
            'codigo_ibge_municipio': cd_mun,
            'nome_municipio': nm_mun,
            'regiao_intermediaria': nm_rgint,
            'regiao_imediata': nm_rgi,
            'concentracao_urbana': nm_concurb,
            'codigo_distrito': cd_dist,
            'nome_distrito': nm_dist,
            'codigo_subdistrito': cd_subdist,
            'nome_subdistrito': nm_subdist,
            'codigo_bairro': cd_bairro,
            'nome_bairro': nm_bairro
        })
    return resultado

def main():
    parser = argparse.ArgumentParser(description="Converte arquivo GPKG de bairros do Censo 2022 (IBGE) para JSON.")
    parser.add_argument('--input', default='BR_bairros_CD2022.gpkg', help='Caminho do arquivo .gpkg')
    parser.add_argument('--output', default='bairros_brasil.json', help='Caminho do arquivo de saída .json')
    parser.add_argument('--formato', choices=['hierarquico', 'plano'], default='hierarquico',
                        help='Formato de saída: hierarquico (Estado -> Município -> Bairro) ou plano (lista de objetos)')
    parser.add_argument('--compacto', action='store_true', help='Exporta JSON sem indentação para menor tamanho')

    args = parser.parse_args()

    rows = extrair_dados_gpkg(args.input)

    if args.formato == 'hierarquico':
        dados = gerar_hierarquico(rows)
    else:
        dados = gerar_plano(rows)

    indent = None if args.compacto else 2
    print(f"Salvando dados estruturados em {args.output}...")
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(dados, f, ensure_ascii=False, indent=indent)

    tamanho_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"Sucesso! Arquivo '{args.output}' gerado com tamanho {tamanho_mb:.2f} MB.")

if __name__ == '__main__':
    main()

