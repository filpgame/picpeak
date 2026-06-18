import { api } from '../config/api';

/**
 * WhatsApp Business API admin config (#640D). The access token is masked on
 * GET — the server returns `'********'` when a token is stored, the empty
 * string when none is. The PUT silently preserves the stored token if the
 * masked sentinel is sent back unchanged.
 */
export interface WhatsAppConfig {
  phone_number_id: string;
  waba_id: string;
  access_token: string; // masked '********' on GET when a real token is stored
  template_name: string;
  enabled: boolean;
}

export const whatsappService = {
  async getConfig(): Promise<WhatsAppConfig> {
    const response = await api.get<WhatsAppConfig>('/admin/whatsapp/config');
    return response.data;
  },

  async updateConfig(config: Partial<WhatsAppConfig>): Promise<{ success: true }> {
    const response = await api.put<{ success: true }>('/admin/whatsapp/config', config);
    return response.data;
  },

  // Sends a static test message to the supplied phone number using the
  // currently-saved config. Returns the Meta message ID on success.
  async sendTest(phone: string): Promise<{ success: boolean; messageId?: string }> {
    const response = await api.post<{ success: boolean; messageId?: string }>(
      '/admin/whatsapp/test',
      { phone },
    );
    return response.data;
  },
};
