import { AlgoViteClientConfig, AlgoViteKMDConfig } from '../../interfaces/network'

const getEnvValue = (primary: string, fallback?: string): string => {
  const primaryValue = import.meta.env[primary]
  if (primaryValue !== undefined && primaryValue !== '') return primaryValue
  if (!fallback) return ''
  const fallbackValue = import.meta.env[fallback]
  return fallbackValue ?? ''
}

export function getAlgodConfigFromViteEnvironment(): AlgoViteClientConfig {
  const server = getEnvValue('VITE_ALGOD_SERVER', 'VITE_ALGOD_NODE_CONFIG_SERVER')
  const port = getEnvValue('VITE_ALGOD_PORT', 'VITE_ALGOD_NODE_CONFIG_PORT')
  const token = getEnvValue('VITE_ALGOD_TOKEN', 'VITE_ALGOD_NODE_CONFIG_TOKEN')
  const network = getEnvValue('VITE_ALGOD_NETWORK')

  if (!server) {
    throw new Error('Attempt to get default algod configuration without specifying VITE_ALGOD_SERVER (or VITE_ALGOD_NODE_CONFIG_SERVER)')
  }

  return {
    server,
    port,
    token,
    network,
  }
}

export function getIndexerConfigFromViteEnvironment(): AlgoViteClientConfig {
  const server = getEnvValue('VITE_INDEXER_SERVER')
  const port = getEnvValue('VITE_INDEXER_PORT')
  const token = getEnvValue('VITE_INDEXER_TOKEN')
  const network = getEnvValue('VITE_ALGOD_NETWORK')

  if (!server) {
    throw new Error('Attempt to get default algod configuration without specifying VITE_INDEXER_SERVER in the environment variables')
  }

  return {
    server,
    port,
    token,
    network,
  }
}

export function getKmdConfigFromViteEnvironment(): AlgoViteKMDConfig {
  const server = getEnvValue('VITE_KMD_SERVER')
  const port = getEnvValue('VITE_KMD_PORT')
  const token = getEnvValue('VITE_KMD_TOKEN')
  const wallet = getEnvValue('VITE_KMD_WALLET')
  const password = getEnvValue('VITE_KMD_PASSWORD')

  if (!server) {
    throw new Error('Attempt to get default kmd configuration without specifying VITE_KMD_SERVER in the environment variables')
  }

  return {
    server,
    port,
    token,
    wallet,
    password,
  }
}
