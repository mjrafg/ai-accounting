import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Ability } from '@casl/ability';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { AttachmentsController } from './Attachments.controller';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AttachmentAction } from './Attachments.types';

describe('AttachmentsController authorization', () => {
  const reflector = new Reflector();
  const guard = new PermissionGuard(reflector);

  const ctx = (handler: any, ability: Ability) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ ability }) }),
      getHandler: () => handler,
      getClass: () => AttachmentsController,
    }) as any;

  const cases: Array<[string, string]> = [
    ['uploadAttachment', AttachmentAction.Create],
    ['linkDocument', AttachmentAction.Create],
    ['unlinkDocument', AttachmentAction.Delete],
    ['getAttachment', AttachmentAction.View],
    ['deleteAttachment', AttachmentAction.Delete],
    ['getAttachmentPresignedUrl', AttachmentAction.View],
  ];

  it.each(cases)(
    '%s is denied (403) for a role with no Attachment permission',
    (method) => {
      const deny = new Ability([]);
      expect(() =>
        guard.canActivate(ctx(AttachmentsController.prototype[method], deny)),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(cases)(
    '%s is allowed for a role that grants the matching Attachment permission',
    (method, action) => {
      const allow = new Ability([
        { action, subject: AbilitySubject.Attachment },
      ] as any);
      expect(
        guard.canActivate(ctx(AttachmentsController.prototype[method], allow)),
      ).toBe(true);
    },
  );

  it('grants all attachment operations to a manage-all (admin) ability', () => {
    const admin = new Ability([{ action: 'manage', subject: 'all' }] as any);
    for (const [method] of cases) {
      expect(
        guard.canActivate(ctx(AttachmentsController.prototype[method], admin)),
      ).toBe(true);
    }
  });
});

// Uses the real mime-types dependency (not mocked) so a broken import binding
// surfaces here the same way it does at runtime.
describe('AttachmentsController getAttachment', () => {
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);

  const makeController = (contentType?: string) => {
    const attachmentsApplication = {
      get: jest.fn().mockResolvedValue({
        Body: { transformToByteArray: async () => bytes },
        ContentType: contentType,
      }),
    } as any;
    const controller = new AttachmentsController(
      attachmentsApplication,
      {} as any,
      {} as any,
    );
    const res = {
      headers: {} as Record<string, string>,
      body: undefined as any,
      set(name: string, value: string) {
        this.headers[name] = value;
      },
      send(payload: any) {
        this.body = payload;
      },
    };
    return { controller, res };
  };

  it.each<[string, string]>([
    ['image/jpeg', 'jpeg'],
    ['application/pdf', 'pdf'],
    ['text/plain', 'txt'],
  ])(
    'responds with Content-Type %s and filename extension .%s',
    async (contentType, extension) => {
      const { controller, res } = makeController(contentType);

      await controller.getAttachment(res as any, 'doc-1');

      expect(res.headers['Content-Type']).toBe(contentType);
      expect(res.headers['Content-Disposition']).toBe(
        `filename="doc-1.${extension}"`,
      );
      expect(res.body).toEqual(Buffer.from(bytes));
    },
  );

  it('defaults to application/octet-stream with a .bin filename when ContentType is missing', async () => {
    const { controller, res } = makeController(undefined);

    await controller.getAttachment(res as any, 'doc-2');

    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.headers['Content-Disposition']).toBe('filename="doc-2.bin"');
    expect(res.body).toEqual(Buffer.from(bytes));
  });
});
