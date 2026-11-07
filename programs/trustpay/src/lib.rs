use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod liquidity;
pub use liquidity::*;

declare_id!("ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A");

#[program]
pub mod trustpay {
    use super::*;
    pub fn initialize_liquidity_vault(ctx: Context<InitializeLiquidityVault>) -> Result<()> {
        liquidity::initialize(ctx)
    }
    pub fn deposit_liquidity(ctx: Context<LiquidityTransfer>, amount: u64) -> Result<()> {
        liquidity::deposit(ctx, amount)
    }
    pub fn withdraw_liquidity(ctx: Context<LiquidityTransfer>, amount: u64) -> Result<()> {
        liquidity::withdraw(ctx, amount)
    }
    pub fn create_order(
        ctx: Context<CreateOrder>,
        id: u64,
        amount: u64,
        title: String,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            !title.trim().is_empty() && title.as_bytes().len() <= 120,
            EscrowError::InvalidTitle
        );
        require_keys_neq!(
            ctx.accounts.client.key(),
            ctx.accounts.freelancer.key(),
            EscrowError::InvalidParty
        );
        require_keys_neq!(
            ctx.accounts.freelancer.key(),
            Pubkey::default(),
            EscrowError::InvalidParty
        );
        let order = &mut ctx.accounts.order;
        order.client = ctx.accounts.client.key();
        order.freelancer = ctx.accounts.freelancer.key();
        order.mint = ctx.accounts.mint.key();
        order.id = id;
        order.amount = amount;
        order.status = Status::Funded;
        order.bump = ctx.bumps.order;
        order.title = title;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }
    pub fn submit_work(ctx: Context<FreelancerAction>) -> Result<()> {
        require!(
            ctx.accounts.order.status == Status::Funded,
            EscrowError::InvalidStatus
        );
        ctx.accounts.order.status = Status::Submitted;
        Ok(())
    }
    pub fn allow_cancel(ctx: Context<FreelancerAction>) -> Result<()> {
        require!(
            ctx.accounts.order.status == Status::Funded,
            EscrowError::InvalidStatus
        );
        ctx.accounts.order.status = Status::CancelApproved;
        Ok(())
    }
    pub fn release(ctx: Context<Settle>) -> Result<()> {
        require!(
            ctx.accounts.order.status == Status::Submitted,
            EscrowError::InvalidStatus
        );
        require_keys_eq!(
            ctx.accounts.destination.owner,
            ctx.accounts.order.freelancer,
            EscrowError::InvalidRecipient
        );
        pay(&ctx)?;
        ctx.accounts.order.status = Status::Paid;
        Ok(())
    }
    pub fn refund(ctx: Context<Settle>) -> Result<()> {
        require!(
            ctx.accounts.order.status == Status::CancelApproved,
            EscrowError::InvalidStatus
        );
        require_keys_eq!(
            ctx.accounts.destination.owner,
            ctx.accounts.order.client,
            EscrowError::InvalidRecipient
        );
        pay(&ctx)?;
        ctx.accounts.order.status = Status::Refunded;
        Ok(())
    }
}
fn pay(ctx: &Context<Settle>) -> Result<()> {
    let order = &ctx.accounts.order;
    let id = order.id.to_le_bytes();
    let bump = [order.bump];
    let seeds: &[&[u8]] = &[b"order", order.client.as_ref(), &id, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: order.to_account_info(),
            },
            &[seeds],
        ),
        order.amount,
        ctx.accounts.mint.decimals,
    )
}
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: only the public identity is stored; no data is read.
    pub freelancer: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = client, space = 8 + Order::INIT_SPACE, seeds = [b"order", client.key().as_ref(), &id.to_le_bytes()], bump)]
    pub order: Account<'info, Order>,
    #[account(init, payer = client, seeds = [b"vault", order.key().as_ref()], bump, token::mint = mint, token::authority = order)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = client)]
    pub source: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct FreelancerAction<'info> {
    pub freelancer: Signer<'info>,
    #[account(mut, has_one = freelancer, seeds = [b"order", order.client.as_ref(), &order.id.to_le_bytes()], bump = order.bump)]
    pub order: Account<'info, Order>,
}
#[derive(Accounts)]
pub struct Settle<'info> {
    pub client: Signer<'info>,
    #[account(mut, has_one = client, has_one = mint, seeds = [b"order", order.client.as_ref(), &order.id.to_le_bytes()], bump = order.bump)]
    pub order: Account<'info, Order>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", order.key().as_ref()], bump, token::mint = mint, token::authority = order)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub client: Pubkey,
    pub freelancer: Pubkey,
    pub mint: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub status: Status,
    pub bump: u8,
    #[max_len(120)]
    pub title: String,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum Status {
    Funded,
    Submitted,
    CancelApproved,
    Paid,
    Refunded,
}
#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Title must contain 1–120 UTF-8 bytes")]
    InvalidTitle,
    #[msg("Client and freelancer must be distinct valid identities")]
    InvalidParty,
    #[msg("Operation is not permitted in the current order status")]
    InvalidStatus,
    #[msg("Incorrect token recipient")]
    InvalidRecipient,
    #[msg("Сумма депозита/вывода должна быть больше нуля")]
    InvalidVaultAmount,
    #[msg("Недостаточно свободных токенов для депозита")]
    InsufficientDepositTokens,
    #[msg("Недостаточно собственных share-токенов для вывода")]
    InsufficientShares,
    #[msg("В Liquidity Vault недостаточно токенов")]
    InsufficientReserve,
    #[msg("Переполнение или некорректная арифметика Vault")]
    MathOverflow,
    #[msg("Резерв Vault не покрывает выпущенные shares")]
    InvalidVaultBacking,
}
