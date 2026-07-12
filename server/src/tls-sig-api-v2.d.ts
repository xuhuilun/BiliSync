declare module "tls-sig-api-v2" {
  class Api {
    constructor(sdkAppId: number, secretKey: string);
    genUserSig(userId: string, expireSeconds: number): string;
    genPrivateMapKeyWithStringRoomID(
      userId: string,
      expireSeconds: number,
      roomId: string,
      privilegeMap: number,
    ): string;
  }

  const moduleValue: { Api: typeof Api };
  export default moduleValue;
}
