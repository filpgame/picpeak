import { api } from '../config/api';

export interface WhatsAppConfig {
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  template_name: string;
  enabled: boolean;
}

export const whatsappConfigService = {
  async getConfig(): Promise<WhatsAppConfig> {
    const response = await api.get('/admin/whatsapp/config');
    return response.data;
  },

  async updateConfig(data: Partial<WhatsAppConfig>): Promise<{ success: boolean }> {
    const response = await api.put('/admin/whatsapp/config', data);
    return response.data;
  },

  async testConfig(phone: string): Promise<{ success: boolean; messageId?: string }> {
    const response = await api.post('/admin/whatsapp/test', { phone });
    return response.data;
  },
};
