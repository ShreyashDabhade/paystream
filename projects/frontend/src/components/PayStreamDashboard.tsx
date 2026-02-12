import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { useWallet } from '@txnlab/use-wallet-react'
import algosdk, { getApplicationAddress, makeAssetTransferTxnWithSuggestedParamsFromObject } from 'algosdk'
import { useSnackbar } from 'notistack'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PayStreamFactory } from '../contracts/PayStream'
import { getAlgodConfigFromViteEnvironment, getIndexerConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'

const SCALE = 1_000_000
const STORAGE_KEY_BASE = 'paystream:mvp:v2'
const QUOTE_WINDOW_MS = 30_000

type Currency = 'USDC' | 'MXN' | 'ARS' | 'TRY' | 'NGN'
type Tab = 'employer' | 'contractor' | 'metrics'
type Mode = 'usd_hold' | 'auto_swap'
type Cadence = 'one-time' | 'weekly' | 'monthly'
type CashOut = 'hold' | 'instant' | 'standard'

interface Contractor {
  id: string
  name: string
  email: string
  address: string
  preferred: Currency
  bankHint: string
  generated: boolean
  assetOptedIn?: boolean
  usdc: number
  local: number
}

interface Schedule {
  id: string
  contractorId: string
  amountUsdc: number
  cadence: Cadence
  mode: Mode
  nextDate: string
  status: 'active' | 'completed'
}

interface Quote {
  amountUsdc: number
  currency: Currency
  output: number
  rate: number
  expiresAt: number
}

interface Activity {
  id: string
  kind: 'deposit' | 'payment' | 'cashout' | 'schedule'
  at: string
  contractorId?: string
  txId?: string
  round?: number
  usdc?: number
  currency?: Currency
  output?: number
  note: string
}

interface Persisted {
  appId: number | null
  assetId: string
  contractors: Contractor[]
  schedules: Schedule[]
  activity: Activity[]
  selected: string
}

const RATES: Record<Currency, number> = { USDC: 1, MXN: 17, ARS: 1050, TRY: 33.5, NGN: 1510 }
const LABELS: Record<Currency, string> = {
  USDC: 'USDCa',
  MXN: 'MXN stable',
  ARS: 'ARS stable',
  TRY: 'TRY stable',
  NGN: 'NGN stable',
}

const makeId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const toUsdc = (value: string | number) => Math.round(Number(value) * SCALE)
const fmtUsdc = (micro: number) => (micro / SCALE).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmt = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const err = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isPendingWalletRequestError = (message: string) => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('transaction request pending') ||
    normalized.includes('another transaction request in progress') ||
    normalized.includes('already has a pending request') ||
    normalized.includes('confirmation failed(4100)') ||
    normalized.includes('code 4100') ||
    normalized.includes('request pending')
  )
}

const clearWalletSessionStorage = () => {
  if (typeof window === 'undefined') return 0

  const prefixes = ['@txnlab/use-wallet', 'walletconnect', '@walletconnect', 'wc@2:']
  const keys: string[] = []

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (!key) continue
    if (prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key)
  }

  keys.forEach((key) => window.localStorage.removeItem(key))
  return keys.length
}

const today = () => new Date().toISOString().slice(0, 10)

const nextDate = (date: string, cadence: Cadence) => {
  if (cadence === 'one-time') return null
  const d = new Date(`${date}T00:00:00.000Z`)
  if (cadence === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  if (cadence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

const quoteFor = (amountUsdc: number, currency: Currency): Quote => {
  const spread = 0.995
  const baseUsdc = amountUsdc / SCALE
  const output = currency === 'USDC' ? baseUsdc : baseUsdc * RATES[currency] * spread
  return {
    amountUsdc,
    currency,
    output,
    rate: RATES[currency],
    expiresAt: Date.now() + QUOTE_WINDOW_MS,
  }
}

const txExplorer = (network: string, txId: string) => {
  if (network === 'testnet') return `https://lora.algokit.io/testnet/transaction/${txId}`
  if (network === 'mainnet') return `https://lora.algokit.io/mainnet/transaction/${txId}`
  return ''
}

const emptyPersisted = (assetId: string): Persisted => ({
  appId: null,
  assetId,
  contractors: [],
  schedules: [],
  activity: [],
  selected: '',
})

const loadPersisted = (storageKey: string, assetId: string): Persisted => {
  if (typeof window === 'undefined') return emptyPersisted(assetId)
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyPersisted(assetId)
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      appId: typeof parsed.appId === 'number' ? parsed.appId : null,
      assetId: typeof parsed.assetId === 'string' ? parsed.assetId : assetId,
      contractors: Array.isArray(parsed.contractors) ? parsed.contractors : [],
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      selected: typeof parsed.selected === 'string' ? parsed.selected : '',
    }
  } catch {
    return emptyPersisted(assetId)
  }
}

export default function PayStreamDashboard() {
  const { enqueueSnackbar } = useSnackbar()
  const { activeAddress, transactionSigner, wallets } = useWallet()

  const envAssetId = String(import.meta.env.VITE_USDCA_ASSET_ID ?? '10458941')

  const algodConfig = useMemo(() => getAlgodConfigFromViteEnvironment(), [])
  const storageKey = useMemo(() => `${STORAGE_KEY_BASE}:${algodConfig.network}`, [algodConfig.network])
  const persisted = useMemo(() => loadPersisted(storageKey, envAssetId), [envAssetId, storageKey])

  const [tab, setTab] = useState<Tab>('employer')
  const [assetId, setAssetId] = useState<string>(envAssetId || persisted.assetId)
  const [appIdInput, setAppIdInput] = useState<string>(persisted.appId ? String(persisted.appId) : '')
  const [appId, setAppId] = useState<number | null>(persisted.appId)
  const [vaultBalance, setVaultBalance] = useState<number>(0)
  const [totalDeposited, setTotalDeposited] = useState<number>(0)
  const [onChain, setOnChain] = useState<Array<{ txId: string; round?: number; sender?: string; time?: number }>>([])
  const [loading, setLoading] = useState<string>('')

  const [depositUsdc, setDepositUsdc] = useState<string>('100')
  const [contractors, setContractors] = useState<Contractor[]>(persisted.contractors)
  const [contractorForm, setContractorForm] = useState({
    name: '',
    email: '',
    address: '',
    preferred: 'MXN' as Currency,
    bankHint: '',
  })

  const [payment, setPayment] = useState({
    contractorId: persisted.selected,
    amount: '500',
    mode: 'auto_swap' as Mode,
  })
  const [quote, setQuote] = useState<Quote | null>(null)

  const [scheduleForm, setScheduleForm] = useState({
    contractorId: persisted.selected,
    amount: '100',
    cadence: 'weekly' as Cadence,
    mode: 'auto_swap' as Mode,
    start: today(),
  })
  const [schedules, setSchedules] = useState<Schedule[]>(persisted.schedules)

  const [selected, setSelected] = useState<string>(persisted.selected)
  const [cashMode, setCashMode] = useState<CashOut>('instant')
  const [cashAmount, setCashAmount] = useState<string>('100')
  const [bankAccount, setBankAccount] = useState('')
  const [activity, setActivity] = useState<Activity[]>(persisted.activity)
  const walletRequestInFlight = useRef(false)
  const [walletRequestBusy, setWalletRequestBusy] = useState(false)
  const [walletPendingError, setWalletPendingError] = useState(false)
  const [walletPendingDetail, setWalletPendingDetail] = useState('')
  const indexerConfig = useMemo(() => getIndexerConfigFromViteEnvironment(), [])
  const algorand = useMemo(() => AlgorandClient.fromConfig({ algodConfig, indexerConfig }), [algodConfig, indexerConfig])

  useEffect(() => {
    algorand.setDefaultSigner(transactionSigner)
  }, [algorand, transactionSigner])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(storageKey, JSON.stringify({ appId, assetId, contractors, schedules, activity, selected }))
  }, [activity, appId, assetId, contractors, schedules, selected, storageKey])

  useEffect(() => {
    if (!selected && contractors.length > 0) setSelected(contractors[0].id)
  }, [contractors, selected])

  const selectedContractor = contractors.find((c) => c.id === selected)
  const paymentContractor = contractors.find((c) => c.id === payment.contractorId)
  const dueSchedules = schedules.filter((s) => s.status === 'active' && s.nextDate <= today())
  const parsedAsset = Number(assetId)
  const isActionBusy = walletRequestBusy || walletPendingError || loading !== ''

  const connect = useCallback(async () => {
    const wallet = wallets.find((w) => w.id === 'pera')
    if (!wallet) {
      enqueueSnackbar('Pera wallet is unavailable. Install/enable Pera and reload.', { variant: 'error' })
      return
    }

    const nonPeraActive = wallets.find((w) => w.isActive && w.id !== 'pera')
    if (nonPeraActive) {
      await nonPeraActive.disconnect().catch(() => undefined)
    }

    try {
      if (wallet.isConnected) {
        wallet.setActive()
        return
      }
      await wallet.connect()
    } catch (e) {
      const message = err(e)
      if (isPendingWalletRequestError(message)) {
        setWalletPendingError(true)
        setWalletPendingDetail(message)
      }
      throw e
    }
  }, [enqueueSnackbar, wallets])

  const disconnect = useCallback(async () => {
    const connectedWallets = wallets.filter((wallet) => wallet.isConnected || wallet.isActive)
    if (connectedWallets.length === 0) return
    await Promise.all(connectedWallets.map((wallet) => wallet.disconnect().catch(() => undefined)))
    setWalletPendingError(false)
    setWalletPendingDetail('')
  }, [wallets])

  const resetWalletSession = useCallback(async () => {
    try {
      setLoading('wallet-reset')

      const connectedWallets = wallets.filter((wallet) => wallet.isConnected || wallet.isActive)
      if (connectedWallets.length > 0) {
        await Promise.all(connectedWallets.map((wallet) => wallet.disconnect().catch(() => undefined)))
      }

      walletRequestInFlight.current = false
      setWalletRequestBusy(false)
      setWalletPendingError(false)
      setWalletPendingDetail('')

      const removed = clearWalletSessionStorage()
      enqueueSnackbar(`Wallet session reset. Cleared ${removed} local wallet keys.`, { variant: 'success' })
      window.location.reload()
    } catch (e) {
      enqueueSnackbar(`Wallet reset failed: ${err(e)}`, { variant: 'error' })
    } finally {
      setLoading('')
    }
  }, [enqueueSnackbar, wallets])

  useEffect(() => {
    if (!activeAddress) return
    setWalletPendingError(false)
    setWalletPendingDetail('')
  }, [activeAddress])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const clearPending = () => {
      setWalletPendingError(false)
      setWalletPendingDetail('')
    }

    window.addEventListener('focus', clearPending)
    window.addEventListener('visibilitychange', clearPending)
    return () => {
      window.removeEventListener('focus', clearPending)
      window.removeEventListener('visibilitychange', clearPending)
    }
  }, [])

  const factory = useMemo(
    () =>
      new PayStreamFactory({
        algorand,
        defaultSender: activeAddress ?? undefined,
      }),
    [activeAddress, algorand],
  )

  const runWalletTx = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (walletRequestInFlight.current) {
      setWalletPendingError(true)
      throw new Error('Wallet request already pending. Open Pera and approve/reject it first.')
    }

    walletRequestInFlight.current = true
    setWalletRequestBusy(true)
    setWalletPendingError(false)
    setWalletPendingDetail('')
    try {
      const result = await fn()
      setWalletPendingError(false)
      setWalletPendingDetail('')
      return result
    } catch (e) {
      const message = err(e)
      if (isPendingWalletRequestError(message)) {
        setWalletPendingError(true)
        setWalletPendingDetail(message)
        throw new Error('Pera already has a pending request. Use "Reset Wallet Session" below, then reconnect Pera.')
      }
      throw e
    } finally {
      walletRequestInFlight.current = false
      setWalletRequestBusy(false)
    }
  }, [])

  const isAddressOptedInToAsset = useCallback(
    async (address: string): Promise<boolean> => {
      if (!Number.isInteger(parsedAsset) || parsedAsset <= 0) return false
      try {
        await algorand.client.algod.accountAssetInformation(address, parsedAsset).do()
        return true
      } catch (e) {
        const message = err(e).toLowerCase()
        if (
          message.includes('asset not found in account') ||
          message.includes('has not opted in to asset') ||
          message.includes('must optin') ||
          message.includes('does not hold asset') ||
          message.includes('404')
        ) {
          return false
        }
        throw e
      }
    },
    [algorand.client.algod, parsedAsset],
  )

  const getVaultUsdcBalance = useCallback(
    async (targetAppId: number): Promise<number> => {
      const appAddress = String(getApplicationAddress(targetAppId))
      const info = (await algorand.client.algod.accountInformation(appAddress).do()) as {
        assets?: Array<{ assetId?: number | bigint; ['asset-id']?: number | bigint; amount?: number | bigint }>
      }
      const targetAssetId = BigInt(parsedAsset)
      const holding = info.assets?.find((asset) => {
        const assetIdValue = asset.assetId ?? asset['asset-id']
        return assetIdValue !== undefined && BigInt(assetIdValue) === targetAssetId
      })
      if (!holding?.amount) return 0

      const amount = typeof holding.amount === 'bigint' ? holding.amount : BigInt(holding.amount)
      return amount > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(amount)
    },
    [algorand.client.algod, parsedAsset],
  )

  const refreshContractorOptIns = useCallback(async () => {
    if (contractors.length === 0 || !Number.isInteger(parsedAsset) || parsedAsset <= 0) return

    const statuses = await Promise.all(
      contractors.map(async (contractor) => ({
        id: contractor.id,
        optedIn: await isAddressOptedInToAsset(contractor.address).catch(() => false),
      })),
    )

    setContractors((prev) => {
      let changed = false
      const next = prev.map((contractor) => {
        const current = statuses.find((status) => status.id === contractor.id)
        if (!current || contractor.assetOptedIn === current.optedIn) return contractor
        changed = true
        return { ...contractor, assetOptedIn: current.optedIn }
      })
      return changed ? next : prev
    })
  }, [contractors, isAddressOptedInToAsset, parsedAsset])

  useEffect(() => {
    void refreshContractorOptIns()
  }, [refreshContractorOptIns])

  const refresh = useCallback(
    async (target?: number) => {
      const current = target ?? appId
      if (!current || !Number.isInteger(parsedAsset) || parsedAsset <= 0) return

      const client = factory.getAppClientById({ appId: BigInt(current) })
      const state = await client.state.global.getAll()
      setTotalDeposited(Number(state.totalDeposited ?? 0n))
      setVaultBalance(await getVaultUsdcBalance(current))

      const txResult = (await algorand.client.indexer.searchForTransactions().applicationID(current).limit(20).do()) as {
        transactions?: Array<{
          id?: string
          ['confirmed-round']?: number
          sender?: string
          ['round-time']?: number
        }>
      }

      setOnChain(
        (txResult.transactions ?? [])
          .filter((txn) => !!txn.id)
          .map((txn) => ({
            txId: String(txn.id),
            round: txn['confirmed-round'],
            sender: txn.sender,
            time: txn['round-time'],
          })),
      )
    },
    [algorand.client.indexer, appId, factory, getVaultUsdcBalance, parsedAsset],
  )

  useEffect(() => {
    if (appId) void refresh(appId)
  }, [appId, refresh])

  const deploy = async () => {
    try {
      if (!activeAddress || !transactionSigner) throw new Error('Connect wallet first')
      if (!Number.isInteger(parsedAsset) || parsedAsset <= 0) throw new Error('Invalid USDC asset ID')

      setLoading('deploy')
      const createdId = await runWalletTx(async () => {
        const deployment = await factory.send.create.bare()
        const appIdValue = Number(deployment.appClient.appId)

        const client = factory.getAppClientById({ appId: BigInt(appIdValue) })
        await client.appClient.fundAppAccount({ amount: microAlgos(200_000) })
        await client.send.optIn.optInToAsset({
          args: { asset: BigInt(parsedAsset) },
          sender: activeAddress,
          extraFee: microAlgos(2_000),
        })

        return appIdValue
      })

      setAppId(createdId)
      setAppIdInput(String(createdId))
      enqueueSnackbar(`Vault deployed: ${createdId}`, { variant: 'success' })
      await refresh(createdId)
    } catch (e) {
      enqueueSnackbar(`Deploy failed: ${err(e)}`, { variant: 'error' })
    } finally {
      setLoading('')
    }
  }

  const attach = async () => {
    try {
      const parsed = Number(appIdInput)
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('Invalid app ID')
      setLoading('attach')
      setAppId(parsed)
      await refresh(parsed)
      enqueueSnackbar(`Attached to vault: ${parsed}`, { variant: 'success' })
    } catch (e) {
      enqueueSnackbar(`Attach failed: ${err(e)}`, { variant: 'error' })
    } finally {
      setLoading('')
    }
  }

  const deposit = async () => {
    try {
      if (!appId || !activeAddress || !transactionSigner) throw new Error('Connect wallet and select app')
      if (!Number.isInteger(parsedAsset) || parsedAsset <= 0) throw new Error('Invalid USDC asset ID')

      const amount = toUsdc(depositUsdc)
      if (!amount || amount <= 0) throw new Error('Invalid deposit amount')

      setLoading('deposit')
      const client = factory.getAppClientById({ appId: BigInt(appId) })
      const sp = await algorand.client.algod.getTransactionParams().do()

      const payTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: activeAddress,
        receiver: String(getApplicationAddress(appId)),
        assetIndex: parsedAsset,
        amount,
        suggestedParams: sp,
      })

      const result = await runWalletTx(() =>
        client.send.deposit({
          args: { txn: payTxn },
          sender: activeAddress,
          signer: transactionSigner,
          populateAppCallResources: false,
          coverAppCallInnerTransactionFees: false,
        }),
      )

      const txId = result.txIds.length > 0 ? result.txIds[result.txIds.length - 1] : undefined
      const round = (result.confirmation as { ['confirmed-round']?: number } | undefined)?.['confirmed-round']

      setActivity((prev) => [
        {
          id: makeId(),
          kind: 'deposit',
          at: new Date().toISOString(),
          txId,
          round,
          usdc: amount,
          currency: 'USDC',
          output: amount / SCALE,
          note: 'Employer deposited USDCa into vault',
        },
        ...prev,
      ])

      enqueueSnackbar(`Deposited ${fmtUsdc(amount)} USDCa`, { variant: 'success' })
      await refresh()
    } catch (e) {
      enqueueSnackbar(`Deposit failed: ${err(e)}`, { variant: 'error' })
    } finally {
      setLoading('')
    }
  }

  const addContractor = () => {
    try {
      const name = contractorForm.name.trim()
      const email = contractorForm.email.trim()
      if (!name || !email) throw new Error('Name and email are required')

      let address = contractorForm.address.trim()
      let generated = false
      if (!address) {
        const account = algosdk.generateAccount()
        address = typeof account.addr === 'string' ? account.addr : account.addr.toString()
        generated = true
      }

      if (!algosdk.isValidAddress(address)) throw new Error('Invalid Algorand address')

      const contractor: Contractor = {
        id: makeId(),
        name,
        email,
        address,
        preferred: contractorForm.preferred,
        bankHint: contractorForm.bankHint.trim(),
        generated,
        assetOptedIn: false,
        usdc: 0,
        local: 0,
      }

      setContractors((prev) => [contractor, ...prev])
      setPayment((prev) => ({ ...prev, contractorId: contractor.id }))
      setScheduleForm((prev) => ({ ...prev, contractorId: contractor.id }))
      setSelected(contractor.id)
      setContractorForm((prev) => ({ ...prev, name: '', email: '', address: '', bankHint: '' }))
      enqueueSnackbar(`Added contractor: ${name}`, { variant: 'success' })
    } catch (e) {
      enqueueSnackbar(`Contractor add failed: ${err(e)}`, { variant: 'error' })
    }
  }

  const removeContractor = (contractorId: string) => {
    setContractors((prev) => prev.filter((c) => c.id !== contractorId))
    setSchedules((prev) => prev.filter((s) => s.contractorId !== contractorId))
    if (selected === contractorId) setSelected('')
  }

  const createQuote = () => {
    if (!paymentContractor) {
      enqueueSnackbar('Select contractor first', { variant: 'error' })
      return
    }
    const amount = toUsdc(payment.amount)
    if (!amount || amount <= 0) {
      enqueueSnackbar('Invalid payment amount', { variant: 'error' })
      return
    }
    const currency: Currency = payment.mode === 'auto_swap' ? paymentContractor.preferred : 'USDC'
    setQuote(quoteFor(amount, currency))
  }

  const optInConnectedWalletForContractor = async (contractorId: string) => {
    try {
      const contractor = contractors.find((c) => c.id === contractorId)
      if (!contractor) throw new Error('Contractor not found')
      if (!activeAddress || !transactionSigner) throw new Error('Connect a wallet first')
      if (!Number.isInteger(parsedAsset) || parsedAsset <= 0) throw new Error('Invalid USDC asset ID')
      if (contractor.address !== activeAddress) {
        throw new Error('Connect the contractor wallet address to opt-in this account')
      }

      setLoading('contractor-optin')
      await runWalletTx(() => algorand.send.assetOptIn({ sender: activeAddress, assetId: BigInt(parsedAsset) }))
      enqueueSnackbar(`Asset ${parsedAsset} opt-in complete`, { variant: 'success' })
      await refreshContractorOptIns()
    } catch (e) {
      const message = err(e)
      if (message.toLowerCase().includes('already')) {
        enqueueSnackbar('Wallet is already opted in', { variant: 'info' })
        await refreshContractorOptIns()
        return
      }
      enqueueSnackbar(`Opt-in failed: ${message}`, { variant: 'error' })
    } finally {
      setLoading('')
    }
  }

  const executePayment = useCallback(
    async (contractorId: string, amountUsdc: number, mode: Mode, scheduleId?: string) => {
      if (!appId || !activeAddress || !transactionSigner) throw new Error('Connect wallet and set app id')
      if (!Number.isInteger(parsedAsset) || parsedAsset <= 0) throw new Error('Invalid USDC asset ID')

      const contractor = contractors.find((c) => c.id === contractorId)
      if (!contractor) throw new Error('Contractor not found')

      const available = await getVaultUsdcBalance(appId)
      if (amountUsdc > available) {
        throw new Error(`Insufficient vault balance: ${fmtUsdc(available)} USDCa available, ${fmtUsdc(amountUsdc)} required`)
      }

      const optedIn = await isAddressOptedInToAsset(contractor.address)
      if (!optedIn) {
        throw new Error(`Contractor wallet must opt-in to asset ${parsedAsset} before payout`)
      }

      setLoading('payment')
      const fxQuote = quoteFor(amountUsdc, mode === 'auto_swap' ? contractor.preferred : 'USDC')
      const client = factory.getAppClientById({ appId: BigInt(appId) })

      const result = await runWalletTx(() =>
        client.send.payout({
          args: {
            recipient: contractor.address,
            asset: BigInt(parsedAsset),
            amount: BigInt(amountUsdc),
          },
          sender: activeAddress,
          extraFee: microAlgos(2_000),
        }),
      )

      const txId = result.txIds.length > 0 ? result.txIds[result.txIds.length - 1] : undefined
      const round = (result.confirmation as { ['confirmed-round']?: number } | undefined)?.['confirmed-round']

      setContractors((prev) =>
        prev.map((c) => {
          if (c.id !== contractorId) return c
          if (mode === 'auto_swap' && c.preferred !== 'USDC') {
            return { ...c, local: c.local + fxQuote.output, assetOptedIn: true }
          }
          return { ...c, usdc: c.usdc + amountUsdc, assetOptedIn: true }
        }),
      )

      setActivity((prev) => [
        {
          id: makeId(),
          kind: 'payment',
          at: new Date().toISOString(),
          contractorId,
          txId,
          round,
          usdc: amountUsdc,
          currency: fxQuote.currency,
          output: fxQuote.output,
          note: 'Employer payout executed',
        },
        ...prev,
      ])

      if (scheduleId) {
        setSchedules((prev) =>
          prev.map((s) => {
            if (s.id !== scheduleId) return s
            const next = nextDate(s.nextDate, s.cadence)
            return next ? { ...s, nextDate: next } : { ...s, status: 'completed' }
          }),
        )
      }

      await refresh()
    },
    [
      activeAddress,
      appId,
      contractors,
      factory,
      getVaultUsdcBalance,
      isAddressOptedInToAsset,
      parsedAsset,
      refresh,
      runWalletTx,
      transactionSigner,
    ],
  )

  const payNow = async () => {
    try {
      if (!payment.contractorId) throw new Error('Select contractor')
      const amount = toUsdc(payment.amount)
      if (!amount || amount <= 0) throw new Error('Invalid payment amount')
      await executePayment(payment.contractorId, amount, payment.mode)
      enqueueSnackbar('Payment sent', { variant: 'success' })
    } catch (e) {
      enqueueSnackbar(`Payment failed: ${err(e)}`, { variant: 'error' })
    } finally {
      setLoading('')
    }
  }

  const addSchedule = () => {
    try {
      const amount = toUsdc(scheduleForm.amount)
      if (!scheduleForm.contractorId) throw new Error('Select contractor')
      if (!amount || amount <= 0) throw new Error('Invalid schedule amount')
      if (!scheduleForm.start) throw new Error('Select start date')

      const item: Schedule = {
        id: makeId(),
        contractorId: scheduleForm.contractorId,
        amountUsdc: amount,
        cadence: scheduleForm.cadence,
        mode: scheduleForm.mode,
        nextDate: scheduleForm.start,
        status: 'active',
      }

      setSchedules((prev) => [item, ...prev])
      setActivity((prev) => [
        {
          id: makeId(),
          kind: 'schedule',
          at: new Date().toISOString(),
          contractorId: item.contractorId,
          usdc: item.amountUsdc,
          note: `Scheduled ${item.cadence} payout`,
        },
        ...prev,
      ])
      enqueueSnackbar('Schedule created', { variant: 'success' })
    } catch (e) {
      enqueueSnackbar(`Schedule failed: ${err(e)}`, { variant: 'error' })
    }
  }

  const processDue = async () => {
    if (dueSchedules.length === 0) {
      enqueueSnackbar('No due schedules', { variant: 'info' })
      return
    }

    setLoading('schedule')
    let success = 0
    for (const schedule of dueSchedules) {
      try {
        await executePayment(schedule.contractorId, schedule.amountUsdc, schedule.mode, schedule.id)
        success += 1
      } catch (e) {
        enqueueSnackbar(`Schedule payment failed: ${err(e)}`, { variant: 'error' })
      }
    }
    setLoading('')
    enqueueSnackbar(`Processed ${success}/${dueSchedules.length} due schedules`, { variant: 'success' })
  }

  const runCashOut = () => {
    if (!selectedContractor) {
      enqueueSnackbar('Select contractor first', { variant: 'error' })
      return
    }

    try {
      if (cashMode === 'hold') {
        setActivity((prev) => [
          {
            id: makeId(),
            kind: 'cashout',
            at: new Date().toISOString(),
            contractorId: selectedContractor.id,
            note: 'Contractor selected Hold mode',
          },
          ...prev,
        ])
        return
      }

      if (cashMode === 'instant') {
        const amount = toUsdc(cashAmount)
        if (!amount || amount <= 0) throw new Error('Invalid USDC amount')
        if (amount > selectedContractor.usdc) throw new Error('Insufficient USDC balance')

        const fxQuote = quoteFor(amount, selectedContractor.preferred)
        setContractors((prev) =>
          prev.map((c) => (c.id === selectedContractor.id ? { ...c, usdc: c.usdc - amount, local: c.local + fxQuote.output } : c)),
        )
        setActivity((prev) => [
          {
            id: makeId(),
            kind: 'cashout',
            at: new Date().toISOString(),
            contractorId: selectedContractor.id,
            usdc: amount,
            currency: fxQuote.currency,
            output: fxQuote.output,
            note: 'Instant swap cash-out',
          },
          ...prev,
        ])
        enqueueSnackbar('Instant cash-out completed', { variant: 'success' })
        return
      }

      const local = Number(cashAmount)
      if (!local || local <= 0) throw new Error('Invalid local amount')
      if (local > selectedContractor.local) throw new Error('Insufficient local stable balance')
      if (!bankAccount.trim()) throw new Error('Enter bank account')

      setContractors((prev) => prev.map((c) => (c.id === selectedContractor.id ? { ...c, local: c.local - local } : c)))
      setActivity((prev) => [
        {
          id: makeId(),
          kind: 'cashout',
          at: new Date().toISOString(),
          contractorId: selectedContractor.id,
          currency: selectedContractor.preferred,
          output: local,
          note: `Standard transfer initiated to ${bankAccount.trim()}`,
        },
        ...prev,
      ])
      enqueueSnackbar('Mock bank transfer initiated', { variant: 'success' })
    } catch (e) {
      enqueueSnackbar(`Cash-out failed: ${err(e)}`, { variant: 'error' })
    }
  }

  const exportCsv = () => {
    const rows = activity.filter((a) => !selectedContractor || a.contractorId === selectedContractor.id)
    const lines = [
      'timestamp,type,tx_id,usdc,currency,output,note',
      ...rows.map((a) =>
        [
          a.at,
          a.kind,
          a.txId ?? '',
          a.usdc ? fmtUsdc(a.usdc) : '',
          a.currency ?? '',
          a.output !== undefined ? fmt(a.output) : '',
          a.note.replace(/,/g, ';'),
        ].join(','),
      ),
    ]

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'paystream-history.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportPdf = () => {
    const rows = activity.filter((a) => !selectedContractor || a.contractorId === selectedContractor.id)
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) {
      enqueueSnackbar('Pop-up blocked for PDF export', { variant: 'error' })
      return
    }

    win.document.write(
      `<html><head><title>PayStream Export</title><style>body{font-family:Arial;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px;font-size:12px}</style></head><body><h2>PayStream Transaction History</h2><table><thead><tr><th>Time</th><th>Type</th><th>Tx</th><th>USDC</th><th>Currency</th><th>Output</th><th>Note</th></tr></thead><tbody>${rows
        .map(
          (a) =>
            `<tr><td>${new Date(a.at).toLocaleString()}</td><td>${a.kind}</td><td>${a.txId ?? '-'}</td><td>${a.usdc ? fmtUsdc(a.usdc) : '-'}</td><td>${a.currency ?? '-'}</td><td>${a.output !== undefined ? fmt(a.output) : '-'}</td><td>${a.note}</td></tr>`,
        )
        .join('')}</tbody></table></body></html>`,
    )
    win.document.close()
    win.print()
  }

  const filteredActivity = selectedContractor ? activity.filter((a) => a.contractorId === selectedContractor.id) : activity

  const receiveUri = selectedContractor ? `algorand://${selectedContractor.address}?asset=${assetId}&note=PayStreamInvoice` : ''

  return (
    <div className="paystream-shell">
      <div className="paystream-hero p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="paystream-title text-3xl font-bold">PayStream MVP</h2>
            <p className="paystream-subtitle text-sm text-slate-600">
              Escrowed USDCa payouts with contractor wallet cash-out and 30s rate lock.
            </p>
          </div>
          {!activeAddress ? (
            <button className="btn btn-primary btn-sm" onClick={() => void connect()} disabled={isActionBusy}>
              Connect Wallet
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="paystream-wallet-chip rounded border px-2 py-1 text-xs">
                {activeAddress.slice(0, 8)}...{activeAddress.slice(-6)}
              </span>
              <button className="btn btn-outline btn-sm" onClick={() => void disconnect()} disabled={isActionBusy}>
                Disconnect
              </button>
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="paystream-hero-stat rounded p-2 text-sm">Finality: ~3s</div>
          <div className="paystream-hero-stat rounded p-2 text-sm">Fee: 0.001 ALGO</div>
          <div className="paystream-hero-stat rounded p-2 text-sm">Target spread: 0.5%</div>
        </div>
      </div>

      <div className="p-4">
        <div className="tabs tabs-boxed bg-white/70">
          <button className={`tab ${tab === 'employer' ? 'tab-active' : ''}`} onClick={() => setTab('employer')}>
            Employer
          </button>
          <button className={`tab ${tab === 'contractor' ? 'tab-active' : ''}`} onClick={() => setTab('contractor')}>
            Contractor
          </button>
          <button className={`tab ${tab === 'metrics' ? 'tab-active' : ''}`} onClick={() => setTab('metrics')}>
            Metrics
          </button>
        </div>
      </div>
      {walletRequestBusy && (
        <div className="mx-4 mb-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm text-cyan-800">
          Wallet request pending in Pera. Approve or reject it there before starting a new action.
        </div>
      )}
      {walletPendingError && (
        <div className="mx-4 mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Pera still reports a pending request. If it stays stuck, reset the wallet session.</span>
            <button
              className={`btn btn-xs btn-outline ${loading === 'wallet-reset' ? 'loading' : ''}`}
              onClick={() => void resetWalletSession()}
              disabled={loading !== '' && loading !== 'wallet-reset'}
            >
              Reset Wallet Session
            </button>
          </div>
          {walletPendingDetail && <p className="mt-1 break-all text-xs text-amber-800">Last wallet error: {walletPendingDetail}</p>}
        </div>
      )}

      <div className="space-y-4 p-4 pt-0">
        {tab === 'employer' && (
          <>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="grid gap-3 md:grid-cols-3">
                <input
                  className="input input-bordered bg-white"
                  value={assetId}
                  onChange={(e) => setAssetId(e.target.value)}
                  placeholder="USDC asset id"
                />
                <input
                  className="input input-bordered bg-white"
                  value={appIdInput}
                  onChange={(e) => setAppIdInput(e.target.value)}
                  placeholder="Vault app id"
                />
                <div className="flex gap-2">
                  <button
                    className={`btn btn-primary flex-1 ${loading === 'deploy' ? 'loading' : ''}`}
                    onClick={() => void deploy()}
                    disabled={isActionBusy || !activeAddress}
                  >
                    Deploy
                  </button>
                  <button
                    className={`btn btn-outline ${loading === 'attach' ? 'loading' : ''}`}
                    onClick={() => void attach()}
                    disabled={isActionBusy}
                  >
                    Attach
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded border border-slate-200 bg-white/80 p-2">Total Deposited: {fmtUsdc(totalDeposited)} USDCa</div>
                <div className="rounded border border-slate-200 bg-white/80 p-2">Vault Balance: {fmtUsdc(vaultBalance)} USDCa</div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="flex flex-wrap gap-2">
                <input
                  className="input input-bordered bg-white"
                  type="number"
                  min="0"
                  step="0.01"
                  value={depositUsdc}
                  onChange={(e) => setDepositUsdc(e.target.value)}
                />
                <button
                  className={`btn btn-success ${loading === 'deposit' ? 'loading' : ''}`}
                  onClick={() => void deposit()}
                  disabled={isActionBusy || !appId}
                >
                  Deposit USDCa
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Pera will show one <span className="font-semibold">Multiple Transaction Request</span> with 2 items for deposit: asset
                transfer + app call. That is expected and safe.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <h3 className="font-semibold">Contractors</h3>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <input
                  className="input input-bordered bg-white"
                  placeholder="Name"
                  value={contractorForm.name}
                  onChange={(e) => setContractorForm((p) => ({ ...p, name: e.target.value }))}
                />
                <input
                  className="input input-bordered bg-white"
                  placeholder="Email"
                  value={contractorForm.email}
                  onChange={(e) => setContractorForm((p) => ({ ...p, email: e.target.value }))}
                />
                <input
                  className="input input-bordered bg-white md:col-span-2"
                  placeholder="Address (optional)"
                  value={contractorForm.address}
                  onChange={(e) => setContractorForm((p) => ({ ...p, address: e.target.value }))}
                />
                <select
                  className="select select-bordered bg-white"
                  value={contractorForm.preferred}
                  onChange={(e) => setContractorForm((p) => ({ ...p, preferred: e.target.value as Currency }))}
                >
                  {Object.keys(LABELS).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <input
                  className="input input-bordered bg-white"
                  placeholder="Bank hint"
                  value={contractorForm.bankHint}
                  onChange={(e) => setContractorForm((p) => ({ ...p, bankHint: e.target.value }))}
                />
              </div>
              <div className="mt-2">
                <button className="btn btn-primary btn-sm" onClick={addContractor}>
                  Add
                </button>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Address</th>
                      <th>Pref</th>
                      <th>Asset Opt-In</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {contractors.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center text-slate-500">
                          No contractors
                        </td>
                      </tr>
                    )}
                    {contractors.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="max-w-[180px] truncate font-mono text-xs">{c.address}</td>
                        <td>{c.preferred}</td>
                        <td>
                          <span className={`badge ${c.assetOptedIn ? 'badge-success' : 'badge-warning'} badge-sm`}>
                            {c.assetOptedIn ? 'Ready' : 'Missing'}
                          </span>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <button
                              className={`btn btn-xs btn-outline ${loading === 'contractor-optin' ? 'loading' : ''}`}
                              onClick={() => void optInConnectedWalletForContractor(c.id)}
                              disabled={isActionBusy || !!c.assetOptedIn || c.address !== activeAddress}
                            >
                              Opt-in
                            </button>
                            <button className="btn btn-xs btn-outline btn-error" onClick={() => removeContractor(c.id)}>
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Opt-in action works only when the connected wallet matches the contractor address.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <h3 className="font-semibold">One-time Payment + 30s Quote</h3>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <select
                  className="select select-bordered bg-white"
                  value={payment.contractorId}
                  onChange={(e) => setPayment((p) => ({ ...p, contractorId: e.target.value }))}
                >
                  <option value="">Select contractor</option>
                  {contractors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  className="input input-bordered bg-white"
                  type="number"
                  min="0"
                  step="0.01"
                  value={payment.amount}
                  onChange={(e) => setPayment((p) => ({ ...p, amount: e.target.value }))}
                />
                <select
                  className="select select-bordered bg-white"
                  value={payment.mode}
                  onChange={(e) => setPayment((p) => ({ ...p, mode: e.target.value as Mode }))}
                >
                  <option value="auto_swap">Auto-swap</option>
                  <option value="usd_hold">USDC hold</option>
                </select>
              </div>
              <div className="mt-2 flex gap-2">
                <button className="btn btn-outline btn-sm" onClick={createQuote}>
                  Quote
                </button>
                <button
                  className={`btn btn-primary btn-sm ${loading === 'payment' ? 'loading' : ''}`}
                  onClick={() => void payNow()}
                  disabled={isActionBusy}
                >
                  Pay
                </button>
              </div>
              {quote && (
                <p className="mt-2 text-sm text-cyan-700">
                  {fmtUsdc(quote.amountUsdc)} USDCa -&gt; {fmt(quote.output)} {quote.currency} at rate {quote.rate} (
                  {Date.now() < quote.expiresAt ? 'valid' : 'expired'})
                </p>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <h3 className="font-semibold">Scheduling</h3>
              <div className="mt-2 grid gap-2 md:grid-cols-5">
                <select
                  className="select select-bordered bg-white"
                  value={scheduleForm.contractorId}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, contractorId: e.target.value }))}
                >
                  <option value="">Contractor</option>
                  {contractors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  className="input input-bordered bg-white"
                  type="number"
                  min="0"
                  step="0.01"
                  value={scheduleForm.amount}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, amount: e.target.value }))}
                />
                <select
                  className="select select-bordered bg-white"
                  value={scheduleForm.cadence}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, cadence: e.target.value as Cadence }))}
                >
                  <option value="one-time">one-time</option>
                  <option value="weekly">weekly</option>
                  <option value="monthly">monthly</option>
                </select>
                <select
                  className="select select-bordered bg-white"
                  value={scheduleForm.mode}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, mode: e.target.value as Mode }))}
                >
                  <option value="auto_swap">auto-swap</option>
                  <option value="usd_hold">usd-hold</option>
                </select>
                <input
                  className="input input-bordered bg-white"
                  type="date"
                  value={scheduleForm.start}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, start: e.target.value }))}
                />
              </div>
              <div className="mt-2 flex gap-2">
                <button className="btn btn-primary btn-sm" onClick={addSchedule}>
                  Add Schedule
                </button>
                <button
                  className={`btn btn-accent btn-sm ${loading === 'schedule' ? 'loading' : ''}`}
                  onClick={() => void processDue()}
                  disabled={isActionBusy}
                >
                  Process Due ({dueSchedules.length})
                </button>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>Contractor</th>
                      <th>Amount</th>
                      <th>Cadence</th>
                      <th>Next</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center text-slate-500">
                          No schedules
                        </td>
                      </tr>
                    )}
                    {schedules.map((s) => (
                      <tr key={s.id}>
                        <td>{contractors.find((c) => c.id === s.contractorId)?.name ?? 'Unknown'}</td>
                        <td>{fmtUsdc(s.amountUsdc)} USDCa</td>
                        <td>{s.cadence}</td>
                        <td>{s.nextDate}</td>
                        <td>{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">On-chain App Calls</h3>
                <button className="btn btn-outline btn-xs" onClick={() => void refresh()}>
                  Refresh
                </button>
              </div>
              <div className="max-h-56 overflow-auto">
                <table className="table table-xs">
                  <thead>
                    <tr>
                      <th>Tx</th>
                      <th>Round</th>
                      <th>Sender</th>
                      <th>Time</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {onChain.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center text-slate-500">
                          No txs
                        </td>
                      </tr>
                    )}
                    {onChain.map((t) => (
                      <tr key={t.txId}>
                        <td className="font-mono">{t.txId.slice(0, 12)}...</td>
                        <td>{t.round ?? '-'}</td>
                        <td className="font-mono">{t.sender ? `${t.sender.slice(0, 6)}...${t.sender.slice(-6)}` : '-'}</td>
                        <td>{t.time ? new Date(t.time * 1000).toLocaleString() : '-'}</td>
                        <td>
                          {txExplorer(algodConfig.network, t.txId) && (
                            <a className="link link-info" href={txExplorer(algodConfig.network, t.txId)} target="_blank" rel="noreferrer">
                              view
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {tab === 'contractor' && (
          <>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <select className="select select-bordered bg-white" value={selected} onChange={(e) => setSelected(e.target.value)}>
                  <option value="">Select contractor</option>
                  {contractors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="rounded border border-slate-200 bg-white/80 p-3 text-sm">
                  <div>USDCa: {selectedContractor ? fmtUsdc(selectedContractor.usdc) : '0.00'}</div>
                  <div className="mt-1">
                    Local: {selectedContractor ? fmt(selectedContractor.local) : '0.00'} {selectedContractor?.preferred ?? ''}
                  </div>
                  {selectedContractor && (
                    <div className="mt-2 flex items-center justify-between">
                      <span className={`badge ${selectedContractor.assetOptedIn ? 'badge-success' : 'badge-warning'} badge-sm`}>
                        {selectedContractor.assetOptedIn ? 'ASA Opted-in' : 'ASA Opt-in Required'}
                      </span>
                      <button
                        className={`btn btn-xs btn-outline ${loading === 'contractor-optin' ? 'loading' : ''}`}
                        onClick={() => void optInConnectedWalletForContractor(selectedContractor.id)}
                        disabled={isActionBusy || !!selectedContractor.assetOptedIn || selectedContractor.address !== activeAddress}
                      >
                        Opt-in
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {selectedContractor && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded border border-slate-200 bg-white/80 p-3">
                    <h4 className="font-semibold">Cash Out</h4>
                    <select
                      className="select select-bordered mt-2 w-full bg-white"
                      value={cashMode}
                      onChange={(e) => setCashMode(e.target.value as CashOut)}
                    >
                      <option value="instant">Instant swap</option>
                      <option value="standard">Standard bank transfer</option>
                      <option value="hold">Hold as USDCa</option>
                    </select>
                    {cashMode !== 'hold' && (
                      <input
                        className="input input-bordered mt-2 w-full bg-white"
                        type="number"
                        min="0"
                        step="0.01"
                        value={cashAmount}
                        onChange={(e) => setCashAmount(e.target.value)}
                      />
                    )}
                    {cashMode === 'standard' && (
                      <input
                        className="input input-bordered mt-2 w-full bg-white"
                        placeholder="Bank account"
                        value={bankAccount}
                        onChange={(e) => setBankAccount(e.target.value)}
                      />
                    )}
                    <button className="btn btn-primary btn-sm mt-2 w-full" onClick={runCashOut}>
                      Execute
                    </button>
                  </div>

                  <div className="rounded border border-slate-200 bg-white/80 p-3">
                    <h4 className="font-semibold">QR Receive</h4>
                    <div className="mt-2 break-all font-mono text-xs text-cyan-700">{receiveUri}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <img
                        className="h-24 w-24 rounded bg-white p-1"
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(receiveUri)}`}
                        alt="QR"
                      />
                      <button
                        className="btn btn-outline btn-xs"
                        onClick={async () => {
                          await navigator.clipboard.writeText(receiveUri)
                          enqueueSnackbar('URI copied', { variant: 'success' })
                        }}
                      >
                        Copy URI
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">History</h3>
                <div className="flex gap-2">
                  <button className="btn btn-outline btn-xs" onClick={exportCsv}>
                    CSV
                  </button>
                  <button className="btn btn-outline btn-xs" onClick={exportPdf}>
                    PDF
                  </button>
                </div>
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="table table-xs">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>USDC</th>
                      <th>Output</th>
                      <th>Tx</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActivity.length === 0 && (
                      <tr>
                        <td colSpan={6} className="text-center text-slate-500">
                          No activity
                        </td>
                      </tr>
                    )}
                    {filteredActivity.map((a) => (
                      <tr key={a.id}>
                        <td>{new Date(a.at).toLocaleString()}</td>
                        <td>{a.kind}</td>
                        <td>{a.usdc ? `${fmtUsdc(a.usdc)} USDCa` : '-'}</td>
                        <td>{a.currency && a.output !== undefined ? `${fmt(a.output)} ${a.currency}` : '-'}</td>
                        <td>
                          {a.txId && txExplorer(algodConfig.network, a.txId) ? (
                            <a
                              className="link link-info font-mono"
                              href={txExplorer(algodConfig.network, a.txId)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {a.txId.slice(0, 10)}...
                            </a>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td>{a.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {tab === 'metrics' && (
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
            <h3 className="font-semibold">Competitive Snapshot</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="table table-zebra">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>PayStream</th>
                    <th>Wise</th>
                    <th>PayPal</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Settlement</td>
                    <td>~3s</td>
                    <td>0-2 days</td>
                    <td>0-3 days</td>
                  </tr>
                  <tr>
                    <td>Fee</td>
                    <td>0.001 ALGO</td>
                    <td>1.6-1.9%</td>
                    <td>4.4-6.9%</td>
                  </tr>
                  <tr>
                    <td>FX spread</td>
                    <td>0.5% target</td>
                    <td>0.5-1%</td>
                    <td>3-4%</td>
                  </tr>
                  <tr>
                    <td>USD hold</td>
                    <td>Native USDCa</td>
                    <td>Multi-currency account</td>
                    <td>Platform balance</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              Implemented from project templates: wallet integration, typed PayStream client calls, grouped asset deposit, payout execution,
              and indexer-backed history.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
