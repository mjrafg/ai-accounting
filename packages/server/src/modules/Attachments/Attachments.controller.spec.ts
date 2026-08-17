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

describe('AttachmentsController.getAttachment', () => {
  /** Minimal stand-in for the GetObjectCommandOutput the service returns. */
  const s3Object = (body: string, contentType?: string) => ({
    ContentType: contentType,
    Body: {
      transformToByteArray: async () => new Uint8Array(Buffer.from(body)),
    },
  });

  const makeRes = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      body: undefined as Buffer | undefined,
      set(key: string, value: string) {
        headers[key] = value;
      },
      send(buffer: Buffer) {
        this.body = buffer;
      },
    };
  };

  const controllerReturning = (object: unknown) =>
    new AttachmentsController(
      { get: jest.fn().mockResolvedValue(object) } as any,
      {} as any,
      {} as any,
    );

  // Regression test. This route threw
  //   TypeError: Cannot read properties of undefined (reading 'extension')
  // because `mime` was imported as a default from a CommonJS module. The
  // failure was in the import, not in the handler's logic, so nothing short of
  // actually invoking the handler catches it.
  it('streams the object body and names the file from its content type', async () => {
    const controller = controllerReturning(s3Object('hello', 'text/plain'));
    const res = makeRes();

    await controller.getAttachment(res as any, 'doc-key-1');

    expect(res.headers['Content-Type']).toBe('text/plain');
    expect(res.headers['Content-Disposition']).toBe('filename="doc-key-1.txt"');
    expect(res.body?.toString()).toBe('hello');
  });

  it('falls back to octet-stream when the object has no content type', async () => {
    const controller = controllerReturning(s3Object('raw bytes', undefined));
    const res = makeRes();

    await controller.getAttachment(res as any, 'doc-key-2');

    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.headers['Content-Disposition']).toBe('filename="doc-key-2.bin"');
    expect(res.body?.toString()).toBe('raw bytes');
  });

  it('falls back to .bin when the content type maps to no known extension', async () => {
    const controller = controllerReturning(
      s3Object('x', 'application/x-not-a-real-type'),
    );
    const res = makeRes();

    await controller.getAttachment(res as any, 'doc-key-3');

    expect(res.headers['Content-Type']).toBe('application/x-not-a-real-type');
    expect(res.headers['Content-Disposition']).toBe('filename="doc-key-3.bin"');
  });

  it('resolves a spreadsheet content type to its real extension', async () => {
    const controller = controllerReturning(
      s3Object(
        'sheet',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    );
    const res = makeRes();

    await controller.getAttachment(res as any, 'doc-key-4');

    expect(res.headers['Content-Disposition']).toBe(
      'filename="doc-key-4.xlsx"',
    );
  });
});
