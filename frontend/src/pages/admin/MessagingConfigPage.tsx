import React, { useState, useEffect } from 'react';
import {
  MessageCircle,
  Save,
  Send,
  Eye,
  EyeOff,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Input, Card, Loading } from '../../components/common';
import { whatsappConfigService, type WhatsAppConfig } from '../../services/whatsappConfig.service';

const WHATSAPP_CONFIG_QUERY_KEY = ['whatsapp-config'] as const;

export const MessagingConfigPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showToken, setShowToken] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [showTestModal, setShowTestModal] = useState(false);

  const [form, setForm] = useState<WhatsAppConfig>({
    phone_number_id: '',
    waba_id: '',
    access_token: '',
    template_name: 'gallery_ready',
    enabled: false,
  });

  const { data, isLoading } = useQuery({
    queryKey: WHATSAPP_CONFIG_QUERY_KEY,
    queryFn: () => whatsappConfigService.getConfig(),
  });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (formData: Partial<WhatsAppConfig>) => whatsappConfigService.updateConfig(formData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WHATSAPP_CONFIG_QUERY_KEY });
      toast.success(t('settings.messaging.saved', 'WhatsApp settings saved'));
    },
    onError: () => {
      toast.error(t('settings.messaging.saveFailed', 'Failed to save settings'));
    },
  });

  const testMutation = useMutation({
    mutationFn: (phone: string) => whatsappConfigService.testConfig(phone),
    onSuccess: () => {
      toast.success(t('settings.messaging.testSent', 'Test message sent!'));
      setShowTestModal(false);
      setTestPhone('');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || t('settings.messaging.testFailed', 'Test message failed'));
    },
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <MessageCircle className="w-6 h-6 text-primary-600" />
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('settings.messaging.title', 'Configurações de Mensagens')}
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t('settings.messaging.description', 'Configure WhatsApp Business API to notify clients when their gallery is ready.')}
          </p>
        </div>
      </div>

      <Card padding="md">
        <div className="space-y-6">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {t('settings.messaging.enableWhatsApp', 'Ativar envio por WhatsApp')}
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.messaging.enableDescription', 'Send WhatsApp notification when a gallery is created or published')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                form.enabled ? 'bg-primary-600' : 'bg-neutral-300 dark:bg-neutral-600'
              }`}
              aria-pressed={form.enabled}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <hr className="border-neutral-200 dark:border-neutral-700" />

          {/* Phone Number ID */}
          <Input
            label={t('settings.messaging.phoneNumberId', 'Phone Number ID')}
            value={form.phone_number_id}
            onChange={(e) => setForm((f) => ({ ...f, phone_number_id: e.target.value }))}
            placeholder="123456789012345"
            helperText={t('settings.messaging.phoneNumberIdHelp', 'From Meta for Developers → WhatsApp → Getting Started')}
          />

          {/* WABA ID */}
          <Input
            label={t('settings.messaging.wabaId', 'WhatsApp Business Account ID')}
            value={form.waba_id}
            onChange={(e) => setForm((f) => ({ ...f, waba_id: e.target.value }))}
            placeholder="123456789012345"
            helperText={t('settings.messaging.wabaIdHelp', 'Found in your Meta Business Manager')}
          />

          {/* Access Token */}
          <Input
            label={t('settings.messaging.accessToken', 'Access Token')}
            type={showToken ? 'text' : 'password'}
            value={form.access_token}
            onChange={(e) => setForm((f) => ({ ...f, access_token: e.target.value }))}
            placeholder="EAAxxxxxxxx..."
            helperText={t('settings.messaging.accessTokenHelp', 'System User token with whatsapp_business_messaging permission')}
            rightIcon={
              <button
                type="button"
                className="text-neutral-400 hover:text-neutral-600"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            }
          />

          {/* Template Name */}
          <Input
            label={t('settings.messaging.templateName', 'Nome do Template')}
            value={form.template_name}
            onChange={(e) => setForm((f) => ({ ...f, template_name: e.target.value }))}
            placeholder="gallery_ready"
            helperText={t('settings.messaging.templateNameHelp', 'Exact name of the approved template in Meta Business Manager')}
          />

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button
              variant="primary"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending
                ? t('common.submitting', 'Saving...')
                : t('common.save', 'Save')}
            </Button>

            <Button
              variant="outline"
              leftIcon={<Send className="w-4 h-4" />}
              onClick={() => setShowTestModal(true)}
              disabled={!form.phone_number_id || !form.access_token}
            >
              {t('settings.messaging.testButton', 'Testar')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Test Modal */}
      {showTestModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowTestModal(false)}
        >
          <div
            className="bg-white dark:bg-neutral-800 rounded-xl p-6 w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
              {t('settings.messaging.testModalTitle', 'Enviar mensagem de teste')}
            </h2>
            <Input
              label={t('settings.messaging.testPhoneLabel', 'Número de telefone (formato internacional)')}
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+5511999999999"
            />
            <div className="flex gap-3 mt-4">
              <Button
                variant="primary"
                onClick={() => testMutation.mutate(testPhone)}
                disabled={!testPhone || testMutation.isPending}
              >
                {testMutation.isPending
                  ? t('common.submitting', 'Enviando...')
                  : t('settings.messaging.testSendButton', 'Enviar')}
              </Button>
              <Button variant="outline" onClick={() => setShowTestModal(false)}>
                {t('common.cancel', 'Cancelar')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
