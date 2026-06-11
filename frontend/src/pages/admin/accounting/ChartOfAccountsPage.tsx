/**
 * Accounting → Chart of accounts (Layer A).
 *
 * Full CRUD for the Swiss/LI KMU-Kontenrahmen + MWST codes, plus the mappings
 * the Treuhänder export relies on: which account each expense category books
 * to, the default/system accounts, and the tax-treatment → VAT-code maps.
 *
 * This data drives the export only — picpeak is not a double-entry ledger.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { X, Plus, Pencil, Trash2, AlertCircle } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../../../components/common';
import {
  ledgerService, type LedgerAccount, type VatCode, type AccountType, type VatDirection, type LedgerSettings,
} from '../../../services/ledger.service';
import { categoryLabel } from '../../../services/accounting.service';

const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const labelCls = 'block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';
const TAX_TREATMENTS = ['domestic', 'reverse_charge_service', 'foreign_vat_non_reclaimable', 'import_goods'];
const OUTPUT_RATES = ['8.1', '2.6', '3.8', '0'];
const SETTING_ACCOUNT_KEYS: (keyof LedgerSettings)[] = [
  'ledger_account_debitoren', 'ledger_account_kreditoren', 'ledger_account_bank', 'ledger_account_cash',
  'ledger_account_default_revenue', 'ledger_account_default_expense',
  'ledger_account_mileage', 'ledger_account_per_diem', 'ledger_account_rebilled_revenue',
];

// ── account modal ──────────────────────────────────────────────────────
const AccountModal: React.FC<{ account?: LedgerAccount; onClose: () => void; onDone: () => void }> = ({ account, onClose, onDone }) => {
  const { t } = useTranslation();
  const isEdit = !!account;
  const [number, setNumber] = useState(account?.number ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'expense');
  const save = useMutation({
    mutationFn: () => isEdit ? ledgerService.updateAccount(account!.id, { number, name, type }) : ledgerService.createAccount({ number, name, type }),
    onSuccess: () => { toast.success(t('common.saved', 'Saved.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-20 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{isEdit ? t('ledger.account.editTitle', 'Edit account') : t('ledger.account.addTitle', 'Add account')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div><label className={labelCls}>{t('ledger.account.number', 'Account number')}</label><Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="6700" /></div>
          <div><label className={labelCls}>{t('ledger.account.name', 'Name')}</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className={labelCls}>{t('ledger.account.type', 'Type')}</label>
            <select value={type} onChange={(e) => setType(e.target.value as AccountType)} className={selectCls}>
              {ACCOUNT_TYPES.map((tp) => <option key={tp} value={tp}>{t(`ledger.accountType.${tp}`, tp)}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !number || !name}>{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
        </div>
      </div>
    </div>
  );
};

// ── VAT code modal ─────────────────────────────────────────────────────
const VatModal: React.FC<{ vat?: VatCode; accounts: LedgerAccount[]; onClose: () => void; onDone: () => void }> = ({ vat, accounts, onClose, onDone }) => {
  const { t } = useTranslation();
  const isEdit = !!vat;
  const [code, setCode] = useState(vat?.code ?? '');
  const [name, setName] = useState(vat?.name ?? '');
  const [rate, setRate] = useState<string>(vat ? String(vat.rate) : '8.1');
  const [direction, setDirection] = useState<VatDirection>(vat?.direction ?? 'input');
  const [accountId, setAccountId] = useState<number | ''>(vat?.account_id ?? '');
  const save = useMutation({
    mutationFn: () => {
      const payload = { code, name, rate: Number(rate) || 0, direction, accountId: accountId === '' ? null : Number(accountId) };
      return isEdit ? ledgerService.updateVatCode(vat!.id, payload) : ledgerService.createVatCode(payload);
    },
    onSuccess: () => { toast.success(t('common.saved', 'Saved.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-20 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{isEdit ? t('ledger.vat.editTitle', 'Edit VAT code') : t('ledger.vat.addTitle', 'Add VAT code')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>{t('ledger.vat.code', 'Code')}</label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VST81" /></div>
            <div><label className={labelCls}>{t('ledger.vat.rate', 'Rate %')}</label><Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></div>
          </div>
          <div><label className={labelCls}>{t('ledger.vat.name', 'Name')}</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className={labelCls}>{t('ledger.vat.direction', 'Direction')}</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as VatDirection)} className={selectCls}>
              <option value="input">{t('ledger.vatDirection.input', 'Input (Vorsteuer)')}</option>
              <option value="output">{t('ledger.vatDirection.output', 'Output (Umsatzsteuer)')}</option>
            </select>
          </div>
          <div><label className={labelCls}>{t('ledger.vat.account', 'VAT account')}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('ledger.vat.noAccount', '— none —')}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.number} · {a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !code || !name}>{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
        </div>
      </div>
    </div>
  );
};

export const ChartOfAccountsPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [accountModal, setAccountModal] = useState<{ account?: LedgerAccount } | null>(null);
  const [vatModal, setVatModal] = useState<{ vat?: VatCode } | null>(null);

  const { data: accounts, isLoading: la } = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => ledgerService.listAccounts() });
  const { data: vatCodes, isLoading: lv } = useQuery({ queryKey: ['ledger-vat-codes'], queryFn: () => ledgerService.listVatCodes() });
  const { data: mappings, isLoading: lm } = useQuery({ queryKey: ['ledger-mappings'], queryFn: () => ledgerService.getMappings() });

  // Local editable copy of the settings (default accounts + VAT maps).
  const [settings, setSettings] = useState<LedgerSettings>({});
  useEffect(() => { if (mappings?.settings) setSettings(mappings.settings); }, [mappings?.settings]);

  const accountOptions = useMemo(() => (accounts ?? []).filter((a) => a.active), [accounts]);
  const inputVat = useMemo(() => (vatCodes ?? []).filter((v) => v.direction === 'input'), [vatCodes]);
  const outputVat = useMemo(() => (vatCodes ?? []).filter((v) => v.direction === 'output'), [vatCodes]);

  const refetchAll = () => { qc.invalidateQueries({ queryKey: ['ledger-accounts'] }); qc.invalidateQueries({ queryKey: ['ledger-vat-codes'] }); qc.invalidateQueries({ queryKey: ['ledger-mappings'] }); };

  const delAccount = useMutation({
    mutationFn: (id: number) => ledgerService.deleteAccount(id),
    onSuccess: () => { toast.success(t('common.deleted', 'Deleted.')); refetchAll(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });
  const delVat = useMutation({
    mutationFn: (id: number) => ledgerService.deleteVatCode(id),
    onSuccess: () => { toast.success(t('common.deleted', 'Deleted.')); refetchAll(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });
  const setCat = useMutation({
    mutationFn: ({ id, accId }: { id: number; accId: number | null }) => ledgerService.setCategoryAccount(id, accId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ledger-mappings'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });
  const saveSettings = useMutation({
    mutationFn: () => ledgerService.updateSettings(settings),
    onSuccess: () => { toast.success(t('ledger.settingsSaved', 'Mappings saved.')); qc.invalidateQueries({ queryKey: ['ledger-mappings'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const setAcctSetting = (key: keyof LedgerSettings, value: string) => setSettings((s) => ({ ...s, [key]: value }));
  const setVatMap = (tt: string, code: string) => setSettings((s) => ({ ...s, ledger_vat_map: { ...(s.ledger_vat_map || {}), [tt]: code } }));
  const setOutputVatMap = (rate: string, code: string) => setSettings((s) => ({ ...s, ledger_output_vat_map: { ...(s.ledger_output_vat_map || {}), [rate]: code } }));

  if (la || lv || lm) return <Loading />;

  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>{t('ledger.intro', 'Used only to produce the Treuhänder export — picpeak does not keep double-entry books. The seeded chart + VAT codes follow the Swiss/LI KMU-Kontenrahmen; adjust them to match your Treuhänder’s setup.')}</span>
      </p>

      {/* Default + system accounts */}
      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('ledger.defaults.title', 'Default & system accounts')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {SETTING_ACCOUNT_KEYS.map((key) => (
              <div key={key}>
                <label className={labelCls}>{t(`ledger.defaults.${key}`, key)}</label>
                <select value={settings[key] as string ?? ''} onChange={(e) => setAcctSetting(key, e.target.value)} className={selectCls}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {accountOptions.map((a) => <option key={a.id} value={a.number}>{a.number} · {a.name}</option>)}
                </select>
              </div>
            ))}
          </div>

          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mt-5 mb-2">{t('ledger.vatMap.title', 'VAT code by tax treatment (costs)')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TAX_TREATMENTS.map((tt) => (
              <div key={tt}>
                <label className={labelCls}>{t(`accounting.taxTreatment.${tt}`, tt)}</label>
                <select value={settings.ledger_vat_map?.[tt] ?? ''} onChange={(e) => setVatMap(tt, e.target.value)} className={selectCls}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {inputVat.map((v) => <option key={v.id} value={v.code}>{v.code} · {v.name}</option>)}
                </select>
              </div>
            ))}
          </div>

          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mt-5 mb-2">{t('ledger.outputVatMap.title', 'VAT code by revenue rate')}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {OUTPUT_RATES.map((rate) => (
              <div key={rate}>
                <label className={labelCls}>{rate}%</label>
                <select value={settings.ledger_output_vat_map?.[rate] ?? ''} onChange={(e) => setOutputVatMap(rate, e.target.value)} className={selectCls}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {outputVat.map((v) => <option key={v.id} value={v.code}>{v.code}</option>)}
                </select>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>{saveSettings.isPending ? t('common.saving', 'Saving…') : t('ledger.saveDefaults', 'Save mappings')}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Category → account */}
      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('ledger.categoryMap.title', 'Expense category → account')}</h2>
          <div className="space-y-2">
            {(mappings?.categories ?? []).map((c) => (
              <div key={c.id} className="flex items-center gap-3">
                <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-200">{categoryLabel(c as any, t)}</span>
                <select value={c.ledger_account_id ?? ''} onChange={(e) => setCat.mutate({ id: c.id, accId: e.target.value ? Number(e.target.value) : null })} className={selectCls} style={{ maxWidth: 320 }}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {accountOptions.filter((a) => a.type === 'expense').map((a) => <option key={a.id} value={a.id}>{a.number} · {a.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Chart of accounts */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('ledger.accounts.title', 'Chart of accounts')}</h2>
            <Button size="sm" onClick={() => setAccountModal({})}><Plus className="w-4 h-4 mr-1" /> {t('ledger.account.addTitle', 'Add account')}</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.account.number', 'No.')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.account.name', 'Name')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.account.type', 'Type')}</th>
                  <th className="py-1.5 pr-3 font-medium text-right">{t('common.actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {(accounts ?? []).map((a) => (
                  <tr key={a.id} className={a.active ? '' : 'opacity-50'}>
                    <td className="py-1.5 pr-3 tabular-nums font-medium text-neutral-900 dark:text-neutral-100">{a.number}</td>
                    <td className="py-1.5 pr-3 text-neutral-800 dark:text-neutral-200">{a.name}</td>
                    <td className="py-1.5 pr-3 text-neutral-500 dark:text-neutral-400">{t(`ledger.accountType.${a.type}`, a.type)}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setAccountModal({ account: a })} className="p-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => { if (window.confirm(t('ledger.account.confirmDelete', 'Delete this account?') as string)) delAccount.mutate(a.id); }} className="p-1 text-neutral-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* VAT codes */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('ledger.vatCodes.title', 'VAT codes')}</h2>
            <Button size="sm" onClick={() => setVatModal({})}><Plus className="w-4 h-4 mr-1" /> {t('ledger.vat.addTitle', 'Add VAT code')}</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.vat.code', 'Code')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.vat.name', 'Name')}</th>
                  <th className="py-1.5 pr-3 font-medium text-right">{t('ledger.vat.rate', 'Rate %')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.vat.direction', 'Direction')}</th>
                  <th className="py-1.5 pr-3 font-medium text-right">{t('common.actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {(vatCodes ?? []).map((v) => (
                  <tr key={v.id} className={v.active ? '' : 'opacity-50'}>
                    <td className="py-1.5 pr-3 font-medium text-neutral-900 dark:text-neutral-100">{v.code}</td>
                    <td className="py-1.5 pr-3 text-neutral-800 dark:text-neutral-200">{v.name}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-700 dark:text-neutral-300">{Number(v.rate).toFixed(1)}</td>
                    <td className="py-1.5 pr-3 text-neutral-500 dark:text-neutral-400">{t(`ledger.vatDirection.${v.direction}`, v.direction)}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setVatModal({ vat: v })} className="p-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => { if (window.confirm(t('ledger.vat.confirmDelete', 'Delete this VAT code?') as string)) delVat.mutate(v.id); }} className="p-1 text-neutral-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {accountModal && <AccountModal account={accountModal.account} onClose={() => setAccountModal(null)} onDone={() => { setAccountModal(null); refetchAll(); }} />}
      {vatModal && <VatModal vat={vatModal.vat} accounts={accounts ?? []} onClose={() => setVatModal(null)} onDone={() => { setVatModal(null); refetchAll(); }} />}
    </div>
  );
};

export default ChartOfAccountsPage;
