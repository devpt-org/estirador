import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { AuditContext } from 'src/internals/auditing/audit-context';
import { Connection, EntityManager } from 'typeorm';
import { SignupVerificationToken } from './signup-verification-tokens/typeorm/signup-verification-token.entity';
import { User } from './typeorm/user.entity';
import { UsersRepository } from './users.repository';
import bcrypt from 'bcrypt';
import { PartialFields } from '@app/shared/internals/utils/types/partial-types';
import { Role } from 'src/auth/roles/roles';
import { SignupVerificationTokensRepository } from './signup-verification-tokens/signup-verifications-token.repository';
import { USERS_SIGNUP_VERIFICATION_TTL } from './users.constants';
import { EmailService } from 'src/internals/email/email.service';
import { SignupResult, UserSignupRequestDTO } from './users.dto';
import { NonNullableFields } from '@app/shared/internals/utils/types/nullable-types';

@Injectable()
export class UsersService {
  constructor(
    @InjectConnection() private connection: Connection,
    private emailService: EmailService,
  ) {}

  /*
  -----------
  -----------
  
  LOGIN

  -----------
  -----------
  */
  async doCredentialsMatch(
    manager: EntityManager,
    email: string,
    password: string,
  ): Promise<{ result: 'match'; user: User } | { result: 'dont-match' }> {
    const usersRepository = manager.getCustomRepository(UsersRepository);

    const user = (await usersRepository.findOne({
      where: { email, isVerified: true },
      select: ['passwordHash', 'passwordSalt'],
    })) as undefined | NonNullableFields<User, 'passwordHash' | 'passwordSalt'>;

    if (!user) {
      return { result: 'dont-match' };
    }

    const incomingPasswordHash = await bcrypt.hash(password, user.passwordSalt);

    return incomingPasswordHash === user.passwordHash
      ? { result: 'match', user }
      : { result: 'dont-match' };
  }

  /*
  -----------
  -----------
  
  SIGNUP

  -----------
  -----------
  */

  async verifyUser(
    auditContext: AuditContext,
    tokenId: SignupVerificationToken['id'],
  ): Promise<'ok' | 'not-found'> {
    return this.connection.transaction(async (manager) => {
      const usersRepository = manager.getCustomRepository(UsersRepository);
      const signupVerificationTokensRepository = manager.getCustomRepository(
        SignupVerificationTokensRepository,
      );

      const token = await signupVerificationTokensRepository.findTokenById(
        tokenId,
      );

      if (!token) {
        return 'not-found';
      } else {
        const user = token.user;

        user.isVerified = true;

        await usersRepository.save(auditContext, user);
        await signupVerificationTokensRepository.deleteFromUser(user);

        return 'ok';
      }
    });
  }

  async sendVerificationLinkEmail(to: string, verificationLink: string) {
    await this.emailService.sendEmail({
      to,
      body: `
<p>Click or copy this link to verify your newly created account: <a href="${verificationLink}" target="_blank">${verificationLink}</a></p>
`,
    });
  }

  async resendSignupVerificationToken(
    email: User['email'],
    hostname: string,
  ): Promise<'ok' | 'not-found'> {
    return this.connection.transaction(async (manager) => {
      const usersRepository = manager.getCustomRepository(UsersRepository);
      const signupVerificationTokensRepository = manager.getCustomRepository(
        SignupVerificationTokensRepository,
      );

      const user = await usersRepository.findOne({ where: { email } });

      if (!user) {
        return 'not-found';
      }

      const token = await signupVerificationTokensRepository.findTokenByUser(
        user,
      );

      let verificationLink: string;

      if (!token) {
        await signupVerificationTokensRepository.deleteFromUser(user);

        const newToken = await signupVerificationTokensRepository.createToken(
          user,
          USERS_SIGNUP_VERIFICATION_TTL,
        );

        verificationLink = `${hostname}/verify/${newToken.id}`;
      } else {
        verificationLink = `${hostname}/verify/${token.id}`;
      }

      await this.sendVerificationLinkEmail(user.email, verificationLink);

      return 'ok';
    });
  }

  async signup(
    auditContext: AuditContext,
    data: UserSignupRequestDTO,
    hostname: string,
  ): Promise<SignupResult> {
    return this.connection.transaction(async (manager) => {
      const usersRepository = manager.getCustomRepository(UsersRepository);
      const signupVerificationTokensRepository = manager.getCustomRepository(
        SignupVerificationTokensRepository,
      );

      const doesExist = await usersRepository.findOne({
        where: { email: data.email },
      });

      if (doesExist) {
        if (doesExist.isVerified) {
          return SignupResult.AlreadyCreated;
        } else {
          return SignupResult.AwaitingVerification;
        }
      }

      const passwordSalt = await bcrypt.genSalt();
      const passwordHash = await bcrypt.hash(data.password, passwordSalt);

      const dataWithoutPassword: PartialFields<
        UserSignupRequestDTO,
        'password'
      > = {
        ...data,
      };
      delete dataWithoutPassword.password;

      const user = await usersRepository.create(auditContext, {
        ...dataWithoutPassword,
        passwordHash,
        passwordSalt,
        role: Role.EndUser,
      });

      const newToken = await signupVerificationTokensRepository.createToken(
        user,
        USERS_SIGNUP_VERIFICATION_TTL,
      );

      await this.sendVerificationLinkEmail(
        user.email,
        `${hostname}/verify/${newToken.id}`,
      );

      return SignupResult.Created;
    });
  }
}
