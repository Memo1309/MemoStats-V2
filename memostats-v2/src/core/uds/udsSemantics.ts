// ISO 14229-1 response semantics, independent of how the bytes travelled (see execUds.ts for that).

export type UdsSemantic =
  | 'POSITIVE_RESPONSE'
  | 'NEGATIVE_RESPONSE'
  | 'RESPONSE_PENDING'
  | 'NO_RESPONSE'
  | 'UNEXPECTED_RESPONSE';

export type EcuPresence = 'PRESENT' | 'NOT_CONFIRMED';

/** ISO 14229-1 negative response SID. */
export const UDS_NEGATIVE_RESPONSE_SID = 0x7f;
/** ISO 14229-1 positive response = request SID + 0x40. */
export const UDS_POSITIVE_OFFSET = 0x40;
/** ISO 14229-1 NRC 0x78 requestCorrectlyReceived-ResponsePending: the ECU will answer later. */
export const NRC_RESPONSE_PENDING = 0x78;
/** ISO 14229-2 default P2*server_max: how long an ECU may take after NRC 0x78. */
export const P2_STAR_SERVER_MAX_MS = 5000;

const SID_READ_DATA_BY_IDENTIFIER = 0x22;

/** ISO 14229-1 Annex A negative response codes most likely on read-only requests. */
export const NRC_NAMES: Record<number, string> = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x78: 'requestCorrectlyReceived-ResponsePending',
  0x7e: 'subFunctionNotSupportedInActiveSession',
  0x7f: 'serviceNotSupportedInActiveSession',
};

export interface UdsClassification {
  semantic: UdsSemantic;
  nrc?: number;
}

export function classifyUdsResponse(request: Uint8Array, body: Uint8Array): UdsClassification {
  const [sid, ...params] = request;
  if (body.length === 0 || sid === undefined) return { semantic: 'NO_RESPONSE' };

  if (body[0] === UDS_NEGATIVE_RESPONSE_SID) {
    const nrc = body[2];
    if (body.length < 3 || body[1] !== sid || nrc === undefined) return { semantic: 'UNEXPECTED_RESPONSE' };
    return { semantic: nrc === NRC_RESPONSE_PENDING ? 'RESPONSE_PENDING' : 'NEGATIVE_RESPONSE', nrc };
  }

  if (body[0] !== sid + UDS_POSITIVE_OFFSET) return { semantic: 'UNEXPECTED_RESPONSE' };
  // The identifier echo proves the reply answers *this* request: both DID bytes for 0x22,
  // the first parameter (sub-function / PID) for everything else that has one.
  const echoLength = sid === SID_READ_DATA_BY_IDENTIFIER ? 2 : Math.min(1, params.length);
  for (let i = 0; i < echoLength; i++) {
    if (body[i + 1] !== params[i]) return { semantic: 'UNEXPECTED_RESPONSE' };
  }
  return { semantic: 'POSITIVE_RESPONSE' };
}

/** Any valid diagnostic answer — positive, negative or pending — proves the ECU exists. */
export function presenceOf(semantic: UdsSemantic): EcuPresence {
  return semantic === 'POSITIVE_RESPONSE' || semantic === 'NEGATIVE_RESPONSE' || semantic === 'RESPONSE_PENDING'
    ? 'PRESENT'
    : 'NOT_CONFIRMED';
}
