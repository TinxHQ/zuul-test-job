/* @flow */
/* eslint-disable camelcase */

/* DEPRECATED: USE CALLD INSTEAD CTID-NG */

import ApiRequester from '../utils/api-requester';
import type { UUID, RequestError, CTITransfer } from '../domain/types';
import Relocation from '../domain/Relocation';
import ChatMessage from '../domain/ChatMessage';
import Voicemail from '../domain/Voicemail';
import Call from '../domain/Call';
import { TRANSFER_FLOW_BLIND } from '../domain/Phone/CTIPhone';

type CallQuery = {
  from_mobile: boolean,
  extension: string,
  line_id?: number,
  all_lines?: boolean,
};

export default (client: ApiRequester, baseUrl: string) => ({
  updatePresence: (presence: string): Promise<Boolean> =>
    client.put(`${baseUrl}/users/me/presences`, { presence }, null, ApiRequester.successResponseParser),

  listMessages: (participantUuid: ?UUID, limit?: number): Promise<Array<ChatMessage>> => {
    const query: Object = {};

    if (participantUuid) {
      query.participant_user_uuid = participantUuid;
    }

    if (limit) {
      query.limit = limit;
    }

    return client.get(`${baseUrl}/users/me/chats`, query).then(ChatMessage.parseMany);
  },

  sendMessage: (alias: string, msg: string, toUserId: string) => {
    const body = { alias, msg, to: toUserId };

    return client.post(`${baseUrl}/users/me/chats`, body, null, ApiRequester.successResponseParser);
  },

  makeCall: (extension: string, fromMobile: boolean, lineId: ?number, allLines: ?boolean = false) => {
    const query: CallQuery = {
      from_mobile: fromMobile,
      extension,
    };

    if (lineId) {
      query.line_id = lineId;
    }

    if (allLines) {
      query.all_lines = true;
    }

    return client.post(`${baseUrl}/users/me/calls`, query);
  },

  cancelCall: (callId: number): Promise<Boolean> => client.delete(`${baseUrl}/users/me/calls/${callId}`),

  listCalls: (): Promise<Array<Call>> =>
    client.get(`${baseUrl}/users/me/calls`).then(response => Call.parseMany(response.items)),

  relocateCall(callId: number, destination: string, lineId: ?number, contact?: ?string): Promise<Relocation> {
    const body: Object = {
      completions: ['answer'],
      destination,
      initiator_call: callId,
      auto_answer: true,
    };

    if (lineId || contact) {
      body.location = {};
    }

    if (lineId) {
      body.location.line_id = lineId;
    }

    if (contact) {
      body.location.contact = contact;
    }

    return client.post(`${baseUrl}/users/me/relocates`, body).then(response => Relocation.parse(response));
  },

  transferCall(
    callId: number,
    number: string,
    flow: string = TRANSFER_FLOW_BLIND,
  ): Promise<RequestError | CTITransfer> {
    const body: Object = {
      exten: number,
      flow,
      initiator_call: callId,
    };

    return client.post(`${baseUrl}/users/me/transfers`, body).then(response => response);
  },

  // @TODO: fix response type
  cancelCallTransfer: (transferId: string): Promise<RequestError | void> =>
    client.delete(`${baseUrl}/users/me/transfers/${transferId}`),

  // @TODO: fix response type
  confirmCallTransfer: (transferId: string): Promise<RequestError | void> =>
    client.put(`${baseUrl}/users/me/transfers/${transferId}/complete`),

  listVoicemails: (): Promise<RequestError | Array<Voicemail>> =>
    client.get(`${baseUrl}/users/me/voicemails`, null).then(response => Voicemail.parseMany(response)),

  deleteVoicemail: (voicemailId: number): Promise<Boolean> =>
    client.delete(`${baseUrl}/users/me/voicemails/messages/${voicemailId}`, null),

  getPresence: (contactUuid: UUID): Promise<{ presence: string, user_uuid: string, xivo_uuid: string }> =>
    client.get(`${baseUrl}/users/${contactUuid}/presences`, null),

  getStatus: (lineUuid: UUID) => client.get(`${baseUrl}/lines/${lineUuid}/presences`, null),

  fetchSwitchboardHeldCalls: (switchboardUuid: UUID) =>
    client.get(`${baseUrl}/switchboards/${switchboardUuid}/calls/held`, null),

  holdSwitchboardCall: (switchboardUuid: UUID, callId: string) =>
    client.put(
      `${baseUrl}/switchboards/${switchboardUuid}/calls/held/${callId}`,
      null,
      null,
      ApiRequester.successResponseParser,
    ),

  answerSwitchboardHeldCall: (switchboardUuid: UUID, callId: string) =>
    client.put(`${baseUrl}/switchboards/${switchboardUuid}/calls/held/${callId}/answer`, null),

  fetchSwitchboardQueuedCalls: (switchboardUuid: UUID) =>
    client.get(`${baseUrl}/switchboards/${switchboardUuid}/calls/queued`, null),

  answerSwitchboardQueuedCall: (switchboardUuid: UUID, callId: string) =>
    client.put(`${baseUrl}/switchboards/${switchboardUuid}/calls/queued/${callId}/answer`, null),

  sendFax: (extension: string, fax: string, callerId: ?string = null) => {
    const headers = {
      'Content-type': 'application/pdf',
      'X-Auth-Token': client.token,
    };
    const params = ApiRequester.getQueryString({ extension, caller_id: callerId });

    return client.post(`${baseUrl}/users/me/faxes?${params}`, fax, headers);
  },

});
